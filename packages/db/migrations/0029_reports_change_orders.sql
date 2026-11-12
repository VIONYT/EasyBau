-- 0029 Regie-/Einsatzberichte abrechnen (P2.5) and Nachträge aus Mehrmengen (P2.6).
-- Positions of an invoice can come from a signed, billable report of the same project. Finalizing
-- the invoice marks the report as billed (report.billed_in_invoice_id); after a Storno the report
-- can be billed again. A Nachtrag position for a Mehrmenge refers to the contract position it
-- exceeds (variance_of_item_id) – deliberately not via source_item_id, which would add its
-- quantity to the measured quantity of the contract position.

ALTER TABLE document_item ADD COLUMN source_report_id uuid REFERENCES report (id);
CREATE INDEX document_item_source_report_idx ON document_item (source_report_id)
  WHERE source_report_id IS NOT NULL;

ALTER TABLE document_item ADD COLUMN variance_of_item_id uuid REFERENCES document_item (id);
CREATE INDEX document_item_variance_idx ON document_item (variance_of_item_id)
  WHERE variance_of_item_id IS NOT NULL;

-- Report and exceeded position belong to the project of the document.
CREATE OR REPLACE FUNCTION document_item_report_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.variance_of_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_item o JOIN document od ON od.id = o.document_id
    JOIN document d ON d.project_id = od.project_id
    WHERE o.id = NEW.variance_of_item_id AND d.id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'exceeded position belongs to another project' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.source_report_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM report r JOIN document d ON d.project_id = r.project_id
    WHERE r.id = NEW.source_report_id AND d.id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'report belongs to another project' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_document_item_report BEFORE INSERT OR UPDATE OF source_report_id, variance_of_item_id, document_id
  ON document_item FOR EACH ROW EXECUTE FUNCTION document_item_report_check();

-- Signed or billed reports stay unchanged. Only billed_in_invoice_id may be set: once, or again
-- when the invoice it points to was cancelled (Storno → corrected invoice bills the report again).
CREATE OR REPLACE FUNCTION report_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'signed' OR OLD.billed_in_invoice_id IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND NEW.billed_in_invoice_id IS NOT NULL
       AND NEW.billed_in_invoice_id IS DISTINCT FROM OLD.billed_in_invoice_id
       AND (OLD.billed_in_invoice_id IS NULL
            OR (SELECT status FROM document WHERE id = OLD.billed_in_invoice_id) = 'cancelled')
       AND (to_jsonb(NEW) - ARRAY['billed_in_invoice_id', 'updated_at'])
           = (to_jsonb(OLD) - ARRAY['billed_in_invoice_id', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'report % is signed or billed and cannot be changed', OLD.id
      USING ERRCODE = 'P0001', HINT = 'Create a follow-up report instead';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
