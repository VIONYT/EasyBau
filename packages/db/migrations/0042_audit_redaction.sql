-- 0042 Änderungsprotokoll schwärzbar, Projekte gelöschter Privatkunden (DSGVO Art. 17 nach Fristende, Löschkonzept): the hash chain
-- of new events covers a hash of their payload (before/after) instead of the payload itself
-- (hash_version 2). The payload of personal master data can then be removed (redacted) without
-- breaking the chain: everything else of the event stays verifiable, and an unredacted payload
-- is still checked against its hash. Events written before this migration (hash_version 1) keep
-- their formula and cannot be redacted. Nothing else of the append-only rule changes: the only
-- allowed UPDATE is "payload → NULL, redacted_at set" on a version-2 event.

ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS hash_version smallint NOT NULL DEFAULT 1;
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS payload_hash bytea;
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS redacted_at timestamptz;
ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS audit_event_version_ck;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_version_ck CHECK (
  (hash_version = 1 AND payload_hash IS NULL AND redacted_at IS NULL)
  OR (hash_version = 2 AND payload_hash IS NOT NULL
      AND (redacted_at IS NULL OR (before IS NULL AND after IS NULL))));

CREATE OR REPLACE FUNCTION audit_payload_hash(p_before jsonb, p_after jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(convert_to(jsonb_build_object('before', p_before, 'after', p_after)::text, 'UTF8'))
$$;

CREATE OR REPLACE FUNCTION audit_event_hash(e audit_event) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(
    coalesce(e.prev_hash, ''::bytea) ||
    convert_to(
      CASE WHEN e.hash_version = 2 THEN
        jsonb_build_object(
          'v', 2, 'tenant_id', e.tenant_id, 'seq', e.seq, 'actor', e.actor_user_id,
          'action', e.action, 'entity', e.entity, 'entity_id', e.entity_id,
          'payload', encode(e.payload_hash, 'hex'),
          'created_at', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ELSE
        -- Version 1 (until migration 0041): unchanged formula.
        jsonb_build_object(
          'tenant_id', e.tenant_id, 'seq', e.seq, 'actor', e.actor_user_id, 'action', e.action,
          'entity', e.entity, 'entity_id', e.entity_id, 'before', e.before, 'after', e.after,
          'created_at', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      END::text,
      'UTF8'))
$$;

-- New events: version 2 with the payload hash.
CREATE OR REPLACE FUNCTION audit_event_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last audit_event;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text, 0));
  SELECT * INTO last FROM audit_event
    WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last.seq, 0) + 1;
  NEW.prev_hash := last.hash;
  NEW.created_at := clock_timestamp();
  NEW.hash_version := 2;
  NEW.payload_hash := audit_payload_hash(NEW.before, NEW.after);
  NEW.redacted_at := NULL;
  NEW.hash := audit_event_hash(NEW);
  RETURN NEW;
END
$$;

-- An event is valid when its hash fits and – unless redacted – its payload fits the payload hash.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  e audit_event;
  expected_prev bytea := NULL;
  expected_seq bigint := 1;
BEGIN
  FOR e IN SELECT * FROM audit_event WHERE tenant_id = p_tenant ORDER BY seq LOOP
    IF e.seq <> expected_seq
       OR e.prev_hash IS DISTINCT FROM expected_prev
       OR e.hash <> audit_event_hash(e)
       OR (e.hash_version = 2 AND e.redacted_at IS NULL
           AND e.payload_hash <> audit_payload_hash(e.before, e.after)) THEN
      RETURN e.seq;
    END IF;
    expected_prev := e.hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END
$$;

-- Append-only, with one exception: removing the payload of a version-2 event (redaction).
CREATE OR REPLACE FUNCTION audit_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.hash_version = 2 AND OLD.redacted_at IS NULL
     AND NEW.redacted_at IS NOT NULL AND NEW.before IS NULL AND NEW.after IS NULL
     AND (NEW.id, NEW.tenant_id, NEW.seq, NEW.actor_user_id, NEW.action, NEW.entity,
          NEW.entity_id, NEW.created_at, NEW.prev_hash, NEW.hash, NEW.hash_version,
          NEW.payload_hash)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.tenant_id, OLD.seq, OLD.actor_user_id, OLD.action, OLD.entity,
          OLD.entity_id, OLD.created_at, OLD.prev_hash, OLD.hash, OLD.hash_version,
          OLD.payload_hash) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'GoBD: audit records are immutable';
END
$$;
DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_event;
DROP TRIGGER IF EXISTS trg_audit_guard ON audit_event;
CREATE TRIGGER trg_audit_guard BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_guard();

-- Removes the payload of the events of one erased record of the current company. Only personal
-- master data (contacts, logins of the company) – never documents or other tax records.
CREATE OR REPLACE FUNCTION redact_audit_payload(p_entity text, p_entity_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  IF p_entity NOT IN ('contact', 'project', 'membership', 'invitation', 'user_signature') THEN
    RAISE EXCEPTION 'audit events of % cannot be redacted', p_entity USING ERRCODE = 'P0001';
  END IF;
  UPDATE audit_event SET before = NULL, after = NULL, redacted_at = now()
  WHERE tenant_id = current_tenant_id() AND entity = p_entity AND entity_id = p_entity_id
    AND hash_version = 2 AND redacted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION redact_audit_payload(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redact_audit_payload(text, uuid) TO opc_app;

-- Erasing a contact also removes its values from the Änderungsprotokoll (including the event of
-- the erasure itself, which still holds the old values in "before"). Projects of a private
-- customer (person) lose name, description and site address – usually the home address – and are
-- archived; files, photos and reports of those projects are listed in the privacy plan for the
-- company to check (they may be needed as evidence).
CREATE OR REPLACE FUNCTION erase_contact(p_contact uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  done boolean;
  is_person boolean;
  proj record;
BEGIN
  SELECT kind = 'person' INTO is_person FROM contact WHERE id = p_contact;
  DELETE FROM contact_channel WHERE contact_id = p_contact;
  DELETE FROM contact_address WHERE contact_id = p_contact;
  DELETE FROM contact_link WHERE person_id = p_contact OR organization_id = p_contact;
  UPDATE contact SET
    organization_name = CASE WHEN kind = 'organization' THEN 'Gelöschter Kontakt' END,
    first_name = NULL,
    last_name = CASE WHEN kind = 'person' THEN 'Gelöschter Kontakt' END,
    salutation = NULL, title = NULL, website = NULL, color = NULL, description = NULL,
    vat_id = NULL, buyer_reference = NULL, einvoice_email = NULL, einvoice_format = NULL,
    archived_at = coalesce(archived_at, now()), erased_at = now(),
    blocked_at = NULL, blocked_until = NULL
  WHERE id = p_contact AND erased_at IS NULL;
  done := FOUND;
  IF done THEN
    PERFORM redact_audit_payload('contact', p_contact);
    IF is_person THEN
      FOR proj IN SELECT id FROM project WHERE customer_id = p_contact LOOP
        UPDATE project SET
          name = coalesce('Projekt ' || number, 'Gelöschtes Projekt'), description = NULL,
          site_street = NULL, site_street_extra = NULL, site_postal_code = NULL, site_city = NULL,
          site_lat = NULL, site_lon = NULL, archived_at = coalesce(archived_at, now())
        WHERE id = proj.id;
        PERFORM redact_audit_payload('project', proj.id);
      END LOOP;
    END IF;
  END IF;
  RETURN done;
END $$;
GRANT EXECUTE ON FUNCTION erase_contact(uuid) TO opc_app;
