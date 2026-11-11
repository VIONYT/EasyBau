-- 0023 Mahnwesen (DESIGN.md §2, §4.6): Zahlungserinnerung → 1. Mahnung → letzte Mahnung with
-- deadline, fee, Verzugszinsen (§ 288 BGB, to the day from the Basiszinssatz, § 247 BGB) and the
-- Verzugspauschale (§ 288 Abs. 5 BGB). A notice is issued once: its amounts and letter are frozen,
-- the PDF/A is archived (WORM, like every document_artifact) and can be e-mailed as attachment.

-- Basiszinssatz (§ 247 BGB, Bundesbank). Rows without tenant ship with the release; a company can
-- add a newer rate itself when an update is not installed yet.
CREATE TABLE IF NOT EXISTS base_interest_rate (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid REFERENCES tenant (id) ON DELETE CASCADE,
  valid_from    date NOT NULL,
  rate_percent  numeric(6,2) NOT NULL CHECK (rate_percent BETWEEN -20 AND 50),
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS base_interest_rate_uq
  ON base_interest_rate (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), valid_from);
ALTER TABLE base_interest_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE base_interest_rate FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS base_rate_read ON base_interest_rate;
CREATE POLICY base_rate_read ON base_interest_rate FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = current_tenant_id());
DROP POLICY IF EXISTS base_rate_insert ON base_interest_rate;
CREATE POLICY base_rate_insert ON base_interest_rate FOR INSERT
  WITH CHECK (tenant_id = current_tenant_id());
DROP POLICY IF EXISTS base_rate_delete ON base_interest_rate;
CREATE POLICY base_rate_delete ON base_interest_rate FOR DELETE
  USING (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, DELETE ON base_interest_rate TO opc_app;

INSERT INTO base_interest_rate (tenant_id, valid_from, rate_percent) VALUES
  (NULL, '2016-07-01', -0.88),
  (NULL, '2023-01-01', 1.62),
  (NULL, '2023-07-01', 3.12),
  (NULL, '2024-01-01', 3.62),
  (NULL, '2024-07-01', 3.37),
  (NULL, '2025-01-01', 2.27),
  (NULL, '2025-07-01', 1.27),
  (NULL, '2026-01-01', 1.27),
  (NULL, '2026-07-01', 1.52)
ON CONFLICT DO NOTHING;

-- Frozen computation of a notice (amounts are also in letter_snapshot for the PDF).
ALTER TABLE dunning_notice
  ADD COLUMN IF NOT EXISTS business boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS interest_from date,
  ADD COLUMN IF NOT EXISTS interest_to date,
  ADD COLUMN IF NOT EXISTS earlier_charges_cents bigint NOT NULL DEFAULT 0 CHECK (earlier_charges_cents >= 0),
  ADD COLUMN IF NOT EXISTS total_cents bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS dunning_notice_invoice_idx ON dunning_notice (invoice_id);

-- Issued notices are never changed or deleted (rule 7); the existing guard blocks changes of sent
-- notices, this makes it unconditional.
REVOKE UPDATE, DELETE ON dunning_notice FROM opc_app;
DROP TRIGGER IF EXISTS trg_dunning_immutable ON dunning_notice;
CREATE TRIGGER trg_dunning_immutable BEFORE UPDATE OR DELETE ON dunning_notice
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- The archived PDF of a notice is a document_artifact of the invoice.
ALTER TABLE document_artifact DROP CONSTRAINT IF EXISTS document_artifact_kind_check;
ALTER TABLE document_artifact ADD CONSTRAINT document_artifact_kind_check CHECK (kind IN (
  'pdf', 'zugferd_pdf', 'zugferd_xml', 'xrechnung_xml', 'validation_report', 'attachment', 'dunning_pdf'));
ALTER TABLE document_artifact
  ADD COLUMN IF NOT EXISTS dunning_notice_id uuid REFERENCES dunning_notice (id);
ALTER TABLE document_artifact DROP CONSTRAINT IF EXISTS document_artifact_dunning;
ALTER TABLE document_artifact ADD CONSTRAINT document_artifact_dunning CHECK (
  (kind = 'dunning_pdf') = (dunning_notice_id IS NOT NULL)) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS document_artifact_dunning_uq
  ON document_artifact (dunning_notice_id) WHERE dunning_notice_id IS NOT NULL;

-- E-mails with archived originals as attachments (dunning letters; later documents, P2.1).
ALTER TABLE email_message DROP CONSTRAINT IF EXISTS email_message_kind_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_kind_check CHECK (kind IN (
  'invitation', 'test', 'document', 'dunning'));

CREATE TABLE IF NOT EXISTS email_attachment (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  email_message_id uuid NOT NULL REFERENCES email_message (id) ON DELETE CASCADE,
  artifact_id      uuid NOT NULL REFERENCES document_artifact (id),
  filename         text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200)
);
SELECT enable_tenant_rls('email_attachment');
CREATE INDEX IF NOT EXISTS email_attachment_message_idx ON email_attachment (email_message_id);

-- Sent notices: which e-mail delivered a notice (status shown at the notice).
ALTER TABLE email_message ADD COLUMN IF NOT EXISTS dunning_notice_id uuid REFERENCES dunning_notice (id);
CREATE INDEX IF NOT EXISTS email_message_dunning_idx ON email_message (dunning_notice_id)
  WHERE dunning_notice_id IS NOT NULL;

-- Worker (runtime role, all companies): attachments of a claimed message.
CREATE OR REPLACE FUNCTION email_message_attachments(p_message uuid)
RETURNS TABLE (filename text, storage_key text, mime_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.filename, a.storage_key, a.mime_type
  FROM email_attachment e JOIN document_artifact a ON a.id = e.artifact_id
  JOIN email_message m ON m.id = e.email_message_id
  WHERE e.email_message_id = p_message AND m.status = 'sending'
  ORDER BY e.id
$$;
REVOKE ALL ON FUNCTION email_message_attachments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_message_attachments(uuid) TO opc_app;
