-- 0047 Belege nach Ablauf der Aufbewahrungsfrist anonymisieren (C.12, DSGVO Art. 17).
-- Decisions (user, 2026-11-26):
-- * A finalized document is anonymised, not deleted: number, type, dates and amounts stay (the
--   number sequence stays traceable, payments and dunning notices keep their invoice); recipient,
--   texts and item descriptions are replaced; the originals (PDF/XML) are removed from the working
--   copy and listed for the WORM archive, which only the operator can empty (infra/archive-purge.sh,
--   root key; the app key never gets delete rights, ADR 0008).
-- * Nothing happens automatically: the Prüfung area lists due documents, an admin approves them.
-- * Retention: invoices and credit notes (Buchungsbelege) tenant.retention_years (default 10,
--   min. 8, BEG IV), all other documents and dunning notices (Handelsbriefe) 6 years (§ 147 AO,
--   § 257 HGB), counted from the end of the calendar year; never before an archived original's
--   own lock ends.
-- Rule 2 stays: the triggers allow exactly this one change – after the period, with an approval,
-- only the personal columns, once.

ALTER TABLE document ADD COLUMN IF NOT EXISTS purged_at timestamptz;

-- End of the retention period of a finalized document (NULL for drafts).
CREATE OR REPLACE FUNCTION document_retention_end(p_document uuid)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT greatest(
    make_date(extract(year FROM d.document_date)::int
              + CASE WHEN d.type IN ('invoice', 'credit_note') THEN t.retention_years ELSE 6 END, 12, 31),
    (SELECT max(a.locked_until) FROM document_artifact a WHERE a.document_id = d.id),
    (SELECT make_date(extract(year FROM max(n.notice_date))::int + 6, 12, 31)
       FROM dunning_notice n WHERE n.invoice_id = d.id),
    (SELECT make_date(extract(year FROM max(p.paid_on))::int + t.retention_years, 12, 31)
       FROM payment p WHERE p.invoice_id = d.id),
    (SELECT make_date(extract(year FROM max(r.created_at))::int + t.retention_years, 12, 31)
       FROM receivable_adjustment r WHERE r.invoice_id = d.id)
  )
  FROM document d JOIN tenant t ON t.id = d.tenant_id
  WHERE d.id = p_document AND d.finalized_at IS NOT NULL
$$;
GRANT EXECUTE ON FUNCTION document_retention_end(uuid) TO opc_app;

-- Approval and proof (Löschprotokoll): one row per document, never deleted.
CREATE TABLE IF NOT EXISTS document_purge (
  document_id    uuid PRIMARY KEY REFERENCES document (id),
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  type           text NOT NULL,
  number         text NOT NULL,
  document_date  date NOT NULL,
  retention_end  date NOT NULL,
  approved_by    uuid NOT NULL REFERENCES app_user (id),
  approved_at    timestamptz NOT NULL DEFAULT now(),
  purged_at      timestamptz
);
SELECT enable_tenant_rls('document_purge');
SELECT add_audit_trigger('document_purge');
REVOKE DELETE ON document_purge FROM opc_app;

-- Originals of anonymised documents: what was removed, and whether the working copy and the WORM
-- copy are gone. The document_artifact row itself stays (immutable, keeps SHA-256 and size).
CREATE TABLE IF NOT EXISTS artifact_purge (
  artifact_id        uuid PRIMARY KEY REFERENCES document_artifact (id),
  tenant_id          uuid NOT NULL REFERENCES tenant (id),
  document_id        uuid NOT NULL REFERENCES document_purge (document_id),
  storage_key        text NOT NULL,
  locked_until       date NOT NULL,
  archived           boolean NOT NULL,
  purged_at          timestamptz NOT NULL DEFAULT now(),
  file_deleted_at    timestamptz,
  archive_deleted_at timestamptz
);
SELECT enable_tenant_rls('artifact_purge');
REVOKE DELETE ON artifact_purge FROM opc_app;
CREATE INDEX IF NOT EXISTS artifact_purge_file_idx ON artifact_purge (tenant_id) WHERE file_deleted_at IS NULL;

-- Due and approved: the only state in which the guards below let the personal columns change.
CREATE OR REPLACE FUNCTION document_purge_allowed(p_document uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM document_purge p
    WHERE p.document_id = p_document AND p.purged_at IS NULL
      AND document_retention_end(p_document) < current_date
  )
$$;

CREATE OR REPLACE FUNCTION document_purge_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.retention_end := document_retention_end(NEW.document_id);
    IF NEW.retention_end IS NULL OR NEW.retention_end >= current_date THEN
      RAISE EXCEPTION 'retention period of document % has not ended', NEW.document_id
        USING ERRCODE = 'P0001';
    END IF;
    -- The proof always names the document as it is (not what the caller passed).
    SELECT d.tenant_id, d.type, d.number, d.document_date
      INTO NEW.tenant_id, NEW.type, NEW.number, NEW.document_date
      FROM document d WHERE d.id = NEW.document_id;
    RETURN NEW;
  END IF;
  -- Only the step to "purged" (once); the approval itself never changes.
  IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NULL
     OR (to_jsonb(NEW) - 'purged_at') IS DISTINCT FROM (to_jsonb(OLD) - 'purged_at') THEN
    RAISE EXCEPTION 'approval of document % cannot be changed', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_document_purge_guard ON document_purge;
CREATE TRIGGER trg_document_purge_guard BEFORE INSERT OR UPDATE ON document_purge
  FOR EACH ROW EXECUTE FUNCTION document_purge_guard();

-- Rule 2 (0003) with the single exception of the anonymisation.
CREATE OR REPLACE FUNCTION document_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable_after_finalize constant text[] := ARRAY['status', 'sent_at', 'updated_at'];
  purgeable constant text[] := ARRAY['subject', 'place_of_performance', 'intro_text', 'closing_text',
    'cancel_reason', 'contact_person_id', 'recipient_address_id', 'recipient_snapshot', 'purged_at',
    'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'finalized document % cannot be deleted', OLD.number
        USING ERRCODE = 'P0001', HINT = 'GoBD: cancel the document instead';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.finalized_at IS NOT NULL THEN
    IF OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL THEN
      IF NOT document_purge_allowed(OLD.id)
         OR (to_jsonb(NEW) - purgeable) IS DISTINCT FROM (to_jsonb(OLD) - purgeable) THEN
        RAISE EXCEPTION 'document % can only be anonymised after its retention period with an approval',
          OLD.number USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - mutable_after_finalize) IS DISTINCT FROM (to_jsonb(OLD) - mutable_after_finalize) THEN
      RAISE EXCEPTION 'finalized document % is immutable', OLD.number
        USING ERRCODE = 'P0001', HINT = 'GoBD: create a cancellation and a new document';
    END IF;
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'finalized document % cannot return to draft', OLD.number USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Children (0003): item texts of an approved, due document may be replaced, nothing else.
CREATE OR REPLACE FUNCTION guard_finalized_document_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  doc_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  finalized timestamptz;
  item_texts constant text[] := ARRAY['short_text', 'long_text', 'updated_at'];
BEGIN
  SELECT finalized_at INTO finalized FROM document WHERE id = doc_id;
  IF finalized IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'document_item' AND document_purge_allowed(doc_id)
       AND (to_jsonb(NEW) - item_texts) IS NOT DISTINCT FROM (to_jsonb(OLD) - item_texts) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% of a finalized document cannot be changed (%)', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'P0001', HINT = 'GoBD: finalized documents are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.document_id <> OLD.document_id THEN
    SELECT finalized_at INTO finalized FROM document WHERE id = OLD.document_id;
    IF finalized IS NOT NULL THEN
      RAISE EXCEPTION '% cannot be moved out of a finalized document', TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;

-- Dunning notices (0004/0023: immutable) lose their letter snapshot with the invoice, nothing else.
CREATE OR REPLACE FUNCTION dunning_notice_purge_update(o dunning_notice, n dunning_notice)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT n.letter_snapshot IS NULL
     AND (to_jsonb(n) - 'letter_snapshot') IS NOT DISTINCT FROM (to_jsonb(o) - 'letter_snapshot')
     AND document_purge_allowed(o.invoice_id)
$$;

CREATE OR REPLACE FUNCTION dunning_notice_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF dunning_notice_purge_update(OLD, NEW) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'GoBD: audit records are immutable';
END $$;

CREATE OR REPLACE FUNCTION dunning_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  required text := CASE NEW.level WHEN 'first' THEN 'reminder' WHEN 'final' THEN 'first' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM receivable_target_check(NEW.invoice_id);
    IF required IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM dunning_notice WHERE invoice_id = NEW.invoice_id AND level = required) THEN
      RAISE EXCEPTION 'dunning level % requires level % first', NEW.level, required USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.sent_at IS NOT NULL THEN
    IF TG_OP = 'UPDATE' THEN
      IF dunning_notice_purge_update(OLD, NEW) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'sent dunning notice % cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
DROP TRIGGER IF EXISTS trg_dunning_immutable ON dunning_notice;
CREATE TRIGGER trg_dunning_immutable BEFORE UPDATE OR DELETE ON dunning_notice
  FOR EACH ROW EXECUTE FUNCTION dunning_notice_immutable();

-- No new originals for an anonymised document (the PDF would show the replaced texts).
CREATE OR REPLACE FUNCTION artifact_purged_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM document WHERE id = NEW.document_id AND purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'document % is anonymised; no new originals', NEW.document_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_artifact_purged ON document_artifact;
CREATE TRIGGER trg_artifact_purged BEFORE INSERT ON document_artifact
  FOR EACH ROW EXECUTE FUNCTION artifact_purged_guard();

-- Audit payloads (0042) of documents, items and dunning notices can now be redacted as well.
CREATE OR REPLACE FUNCTION redact_audit_payload(p_entity text, p_entity_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  IF p_entity NOT IN ('contact', 'project', 'membership', 'invitation', 'user_signature',
                      'document', 'document_item', 'dunning_notice') THEN
    RAISE EXCEPTION 'audit events of % cannot be redacted', p_entity USING ERRCODE = 'P0001';
  END IF;
  IF p_entity IN ('document', 'document_item', 'dunning_notice') AND NOT EXISTS (
    SELECT 1 FROM document d
    LEFT JOIN document_item i ON i.document_id = d.id AND i.id = p_entity_id
    LEFT JOIN dunning_notice n ON n.invoice_id = d.id AND n.id = p_entity_id
    WHERE d.tenant_id = current_tenant_id() AND d.purged_at IS NOT NULL
      AND (d.id = p_entity_id OR i.id IS NOT NULL OR n.id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'only audit events of anonymised documents can be redacted' USING ERRCODE = 'P0001';
  END IF;
  UPDATE audit_event SET before = NULL, after = NULL, redacted_at = now()
  WHERE tenant_id = current_tenant_id() AND entity = p_entity AND entity_id = p_entity_id
    AND hash_version = 2 AND redacted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Dunning notices are not writable for the app role (0023); this narrow helper only clears the
-- letter snapshots of the current company's approved, due invoice (the guards check it again).
CREATE OR REPLACE FUNCTION purge_dunning_letters(p_document uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM document WHERE id = p_document AND tenant_id = current_tenant_id())
     OR NOT document_purge_allowed(p_document) THEN
    RAISE EXCEPTION 'document % is not approved for anonymisation', p_document USING ERRCODE = 'P0001';
  END IF;
  UPDATE dunning_notice SET letter_snapshot = NULL
  WHERE invoice_id = p_document AND letter_snapshot IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION purge_dunning_letters(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_dunning_letters(uuid) TO opc_app;

-- The anonymisation itself (caller's rights and RLS; one document per call, in its transaction).
CREATE OR REPLACE FUNCTION purge_document(p_document uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  d document;
  r record;
BEGIN
  SELECT * INTO d FROM document WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR d.purged_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF NOT document_purge_allowed(p_document) THEN
    RAISE EXCEPTION 'document % is not approved or still in its retention period', d.number
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO artifact_purge (artifact_id, tenant_id, document_id, storage_key, locked_until, archived)
  SELECT a.id, a.tenant_id, p_document, a.storage_key, a.locked_until,
         EXISTS (SELECT 1 FROM artifact_archive x WHERE x.artifact_id = a.id)
  FROM document_artifact a WHERE a.document_id = p_document
  ON CONFLICT (artifact_id) DO NOTHING;

  UPDATE document_item SET
    short_text = CASE WHEN short_text IS NULL THEN NULL ELSE 'Gelöscht' END,
    long_text = NULL
  WHERE document_id = p_document;

  PERFORM purge_dunning_letters(p_document);

  UPDATE email_message SET
    to_address = 'geloescht@invalid', reply_to = NULL, cc_addresses = '{}', bcc_addresses = '{}',
    subject = 'Gelöscht', body_text = NULL
  WHERE document_id = p_document
     OR dunning_notice_id IN (SELECT id FROM dunning_notice WHERE invoice_id = p_document);

  UPDATE document SET
    subject = NULL, place_of_performance = NULL, intro_text = NULL, closing_text = NULL,
    cancel_reason = CASE WHEN cancel_reason IS NULL THEN NULL ELSE 'Gelöscht' END,
    contact_person_id = NULL, recipient_address_id = NULL,
    recipient_snapshot = jsonb_build_object('name', 'Gelöschter Empfänger', 'lines', '[]'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object('customerNumber', recipient_snapshot -> 'customerNumber')),
    purged_at = now()
  WHERE id = p_document;

  PERFORM redact_audit_payload('document', p_document);
  FOR r IN SELECT id FROM document_item WHERE document_id = p_document LOOP
    PERFORM redact_audit_payload('document_item', r.id);
  END LOOP;
  FOR r IN SELECT id FROM dunning_notice WHERE invoice_id = p_document LOOP
    PERFORM redact_audit_payload('dunning_notice', r.id);
  END LOOP;

  UPDATE document_purge SET purged_at = now() WHERE document_id = p_document;
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION purge_document(uuid) TO opc_app;

-- Archive workers (0021/0025): anonymised originals are neither archived nor restored again.
CREATE OR REPLACE FUNCTION pending_archive_artifacts(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, storage_key text, sha256 bytea, size_bytes bigint,
               mime_type text, locked_until date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.tenant_id, a.storage_key, a.sha256, a.size_bytes, a.mime_type, a.locked_until
  FROM document_artifact a
  LEFT JOIN artifact_archive_attempt t ON t.artifact_id = a.id
  WHERE NOT EXISTS (SELECT 1 FROM artifact_archive r WHERE r.artifact_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM artifact_purge p WHERE p.artifact_id = a.id)
    AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= now())
  ORDER BY a.created_at
  LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION archive_verify_candidates(p_limit integer, p_tenant uuid, p_before timestamptz)
RETURNS TABLE (id uuid, tenant_id uuid, storage_key text, sha256 bytea, size_bytes bigint,
               mime_type text, locked_until date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.tenant_id, a.storage_key, a.sha256, a.size_bytes, a.mime_type, a.locked_until
  FROM artifact_archive r
  JOIN document_artifact a ON a.id = r.artifact_id
  LEFT JOIN LATERAL (
    SELECT max(c.checked_at) AS last FROM artifact_archive_check c WHERE c.artifact_id = a.id
  ) l ON true
  WHERE (p_tenant IS NULL OR a.tenant_id = p_tenant)
    AND NOT EXISTS (SELECT 1 FROM artifact_purge p WHERE p.artifact_id = a.id)
    AND (p_before IS NULL OR l.last IS NULL OR l.last < p_before)
  ORDER BY l.last NULLS FIRST, a.created_at
  LIMIT p_limit
$$;

-- Operator (infra/archive-purge.sh, database superuser): WORM objects to remove, and marking them.
CREATE OR REPLACE FUNCTION archive_purge_due()
RETURNS TABLE (artifact_id uuid, storage_key text, locked_until date)
LANGUAGE sql STABLE AS $$
  SELECT p.artifact_id, p.storage_key, p.locked_until FROM artifact_purge p
  WHERE p.archived AND p.archive_deleted_at IS NULL AND p.locked_until < current_date
  ORDER BY p.purged_at
$$;
REVOKE ALL ON FUNCTION archive_purge_due() FROM PUBLIC;

CREATE OR REPLACE FUNCTION archive_purge_done(p_artifact uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE artifact_purge SET archive_deleted_at = now()
  WHERE artifact_id = p_artifact AND archive_deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION archive_purge_done(uuid) FROM PUBLIC;
