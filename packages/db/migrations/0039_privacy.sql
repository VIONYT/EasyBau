-- 0039 Datenschutz (DSGVO Art. 15, 17, 18) für Kontakte – Löschkonzept (DESIGN.md §9):
-- * not used in tax-relevant records → erased at once (anonymised in place),
-- * used in finalised documents / incoming invoices → blocked (Art. 18, § 147 AO / § 257 HGB)
--   until the retention period of the newest such record ends, then erased by the worker.
-- Erasing = anonymising the row: finalised documents keep their own snapshot (rule 4) and
-- reference the contact only by id; addresses and channels are deleted.

ALTER TABLE contact ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS blocked_until date;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS erased_at timestamptz;
ALTER TABLE contact ADD CONSTRAINT contact_blocked_until_ck
  CHECK ((blocked_at IS NULL) = (blocked_until IS NULL));

-- End of the retention period of everything tax-relevant that names the contact (NULL = nothing):
-- archived originals carry their own date (document_artifact.locked_until); finalised documents
-- without an original count until the end of their year plus the company's retention years.
CREATE OR REPLACE FUNCTION contact_retention_end(p_contact uuid)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT max(d) FROM (
    SELECT a.locked_until AS d
      FROM document_artifact a JOIN document doc ON doc.id = a.document_id
     WHERE doc.contact_id = p_contact OR doc.contact_person_id = p_contact
    UNION ALL
    SELECT a.locked_until
      FROM document_artifact a JOIN incoming_invoice i ON i.id = a.incoming_invoice_id
     WHERE i.contact_id = p_contact
    UNION ALL
    SELECT make_date(extract(year FROM doc.document_date)::int + t.retention_years, 12, 31)
      FROM document doc JOIN tenant t ON t.id = doc.tenant_id
     WHERE (doc.contact_id = p_contact OR doc.contact_person_id = p_contact)
       AND doc.status <> 'draft' AND doc.document_date IS NOT NULL
  ) dates
$$;
GRANT EXECUTE ON FUNCTION contact_retention_end(uuid) TO opc_app;

-- Anonymises one contact of the current company (runs with the caller's rights and RLS).
CREATE OR REPLACE FUNCTION erase_contact(p_contact uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
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
  RETURN FOUND;
END $$;
GRANT EXECUTE ON FUNCTION erase_contact(uuid) TO opc_app;

-- An erased contact stays erased.
CREATE OR REPLACE FUNCTION contact_privacy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'contact % is erased (DSGVO) and cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_contact_privacy ON contact;
CREATE TRIGGER trg_contact_privacy BEFORE UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION contact_privacy_guard();

-- The worker erases blocked contacts whose period has ended, company by company.
CREATE OR REPLACE FUNCTION contacts_due_for_erasure()
RETURNS TABLE (tenant_id uuid, contact_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.id FROM contact c
  WHERE c.blocked_until IS NOT NULL AND c.blocked_until < current_date AND c.erased_at IS NULL
  ORDER BY c.tenant_id, c.blocked_until
$$;
REVOKE ALL ON FUNCTION contacts_due_for_erasure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contacts_due_for_erasure() TO opc_app;
