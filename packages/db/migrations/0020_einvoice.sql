-- 0020 E-Rechnung (rule 8, ADR 0007): every invoice/credit note is issued as ZUGFeRD/Factur-X
-- (CII, embedded in the PDF/A-3) and, if the customer wants it, as XRechnung (UBL or CII). Each XML
-- passes the KoSIT validator before the invoice is finalized; XML, the validation report and the
-- PDF are archived as insert-only document_artifact rows with SHA-256 and retention date.

ALTER TABLE document_artifact DROP CONSTRAINT IF EXISTS document_artifact_kind_check;
ALTER TABLE document_artifact ADD CONSTRAINT document_artifact_kind_check CHECK (kind IN (
  'pdf', 'zugferd_pdf', 'zugferd_xml', 'xrechnung_xml', 'validation_report', 'attachment'));

-- Format of an e-invoice file; the validation report points to the XML it belongs to.
ALTER TABLE document_artifact
  ADD COLUMN IF NOT EXISTS format text CHECK (format IN ('zugferd', 'xrechnung_ubl', 'xrechnung_cii')),
  ADD COLUMN IF NOT EXISTS source_artifact_id uuid REFERENCES document_artifact (id);

-- Rule 8 in the database: an e-invoice is only archived once KoSIT accepted it. NOT VALID: the
-- check applies to every new row; rows written before e-invoicing existed stay as they are.
ALTER TABLE document_artifact DROP CONSTRAINT IF EXISTS document_artifact_einvoice_validated;
ALTER TABLE document_artifact ADD CONSTRAINT document_artifact_einvoice_validated CHECK (
  kind NOT IN ('zugferd_xml', 'xrechnung_xml', 'zugferd_pdf') OR (validated_at IS NOT NULL)) NOT VALID;
ALTER TABLE document_artifact DROP CONSTRAINT IF EXISTS document_artifact_einvoice_format;
ALTER TABLE document_artifact ADD CONSTRAINT document_artifact_einvoice_format CHECK (
  kind NOT IN ('zugferd_xml', 'xrechnung_xml') OR format IS NOT NULL) NOT VALID;

CREATE INDEX IF NOT EXISTS document_artifact_document_idx ON document_artifact (document_id, kind);
