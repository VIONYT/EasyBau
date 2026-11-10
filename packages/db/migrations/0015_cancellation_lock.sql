-- 0015 Storno: a cancelled invoice keeps its number for good and stays cancelled.
-- Already in place: finalized documents (and so their numbers) cannot be deleted or changed
-- (0003), one cancellation per invoice (0003), invoice counters never go backwards (0001).
-- Added here as the last line of defence, independent of application code:
--   1. A cancellation may only refer to a finalized invoice of the same project that is not
--      itself a cancellation and is not cancelled yet.
--   2. Finalizing the cancellation marks the original invoice as cancelled (same transaction).
--   3. "cancelled" is final and only possible with a finalized cancellation.
--   4. Invoice and credit note numbers are unique across both types.
--   5. Invoice/credit note counters cannot be deleted, renamed or reset without the year.
--   6. No new payments or deductions on a cancelled invoice.

-- 1 + 3 ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION document_cancellation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target document;
BEGIN
  IF NEW.cancels_document_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.cancels_document_id IS DISTINCT FROM OLD.cancels_document_id) THEN
    SELECT * INTO target FROM document WHERE id = NEW.cancels_document_id;
    IF NOT FOUND OR target.type <> 'invoice' OR target.finalized_at IS NULL THEN
      RAISE EXCEPTION 'only a finalized invoice can be cancelled' USING ERRCODE = 'P0001';
    END IF;
    IF target.invoice_kind = 'cancellation' THEN
      RAISE EXCEPTION 'a cancellation cannot be cancelled' USING ERRCODE = 'P0001';
    END IF;
    IF target.status = 'cancelled' THEN
      RAISE EXCEPTION 'invoice % is already cancelled', target.number USING ERRCODE = 'P0001';
    END IF;
    IF target.project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'a cancellation must belong to the project of the invoice' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'cancelled invoice % stays cancelled', OLD.number
      USING ERRCODE = 'P0001', HINT = 'GoBD: a cancellation cannot be undone, issue a new invoice';
  END IF;
  IF NEW.status = 'cancelled' AND (TG_OP = 'INSERT' OR OLD.status <> 'cancelled') THEN
    IF NOT EXISTS (
      SELECT 1 FROM document s
      WHERE s.cancels_document_id = NEW.id AND s.finalized_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'document % can only be cancelled by a finalized cancellation', NEW.number
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_document_cancellation_guard BEFORE INSERT OR UPDATE ON document
  FOR EACH ROW EXECUTE FUNCTION document_cancellation_guard();

-- 2 -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION document_cancellation_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cancels_document_id IS NOT NULL AND NEW.finalized_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.finalized_at IS NULL) THEN
    UPDATE document SET status = 'cancelled' WHERE id = NEW.cancels_document_id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER trg_document_cancellation_apply AFTER INSERT OR UPDATE OF finalized_at ON document
  FOR EACH ROW EXECUTE FUNCTION document_cancellation_apply();

-- 4 -------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS document_invoice_number_uq ON document (tenant_id, number)
  WHERE number IS NOT NULL AND type IN ('invoice', 'credit_note');

-- 5 -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION number_sequence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind IN ('invoice', 'credit_note') THEN
      RAISE EXCEPTION 'number sequence % must not be deleted', OLD.kind USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind
     AND (OLD.kind IN ('invoice', 'credit_note') OR NEW.kind IN ('invoice', 'credit_note')) THEN
    RAISE EXCEPTION 'number sequence % cannot be renamed', OLD.kind USING ERRCODE = 'P0001';
  END IF;
  IF NEW.kind IN ('invoice', 'credit_note') THEN
    -- Restarting every year is only unique if the year is part of the number.
    IF NEW.reset_yearly AND NOT NEW.include_year THEN
      RAISE EXCEPTION 'number sequence % can only restart yearly with the year in the number', NEW.kind
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.next_value < OLD.next_value
       AND NOT (NEW.reset_yearly AND NEW.include_year
                AND NEW.current_year > coalesce(OLD.current_year, 0)) THEN
      RAISE EXCEPTION 'number sequence % must not be decreased', OLD.kind USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_number_sequence_guard ON number_sequence;
CREATE TRIGGER trg_number_sequence_guard BEFORE UPDATE OR DELETE ON number_sequence
  FOR EACH ROW EXECUTE FUNCTION number_sequence_guard();

-- 6 -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION receivable_target_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d document;
BEGIN
  SELECT * INTO d FROM document WHERE id = NEW.invoice_id;
  IF d.type NOT IN ('invoice', 'credit_note') OR d.finalized_at IS NULL THEN
    RAISE EXCEPTION 'payments require a finalized invoice' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' AND d.status = 'cancelled' THEN
    RAISE EXCEPTION 'invoice % is cancelled, no payments can be booked on it', d.number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
