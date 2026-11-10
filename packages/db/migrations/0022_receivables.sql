-- 0022 Zahlungen & Forderungen (DESIGN.md §4.6) – no bookkeeping, only per-invoice records:
-- payments and deductions are never deleted (rule 7); a mistake is corrected by a reversal
-- (Gegenbuchung) with the negated amount. Deduction kind for the Bauumlage.

ALTER TABLE receivable_adjustment DROP CONSTRAINT IF EXISTS receivable_adjustment_kind_check;
ALTER TABLE receivable_adjustment ADD CONSTRAINT receivable_adjustment_kind_check CHECK (kind IN (
  'cash_discount', 'retention', 'construction_levy', 'bank_fee', 'short_payment', 'other'));
ALTER TABLE receivable_adjustment
  ADD COLUMN IF NOT EXISTS reverses_adjustment_id uuid REFERENCES receivable_adjustment (id);

-- At most one reversal per entry.
CREATE UNIQUE INDEX IF NOT EXISTS payment_reversal_uq ON payment (reverses_payment_id)
  WHERE reverses_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS receivable_adjustment_reversal_uq
  ON receivable_adjustment (reverses_adjustment_id) WHERE reverses_adjustment_id IS NOT NULL;

-- A reversal mirrors its original exactly (same invoice, negated amount, same kind).
CREATE OR REPLACE FUNCTION receivable_reversal_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original jsonb;
  target uuid := (to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'payment' THEN 'reverses_payment_id'
                                       ELSE 'reverses_adjustment_id' END)::uuid;
BEGIN
  IF target IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE id = $1', TG_TABLE_NAME) INTO original USING target;
  IF original IS NULL
     OR (original ->> 'invoice_id')::uuid <> NEW.invoice_id
     OR (original ->> 'amount_cents')::bigint <> -NEW.amount_cents
     OR (TG_TABLE_NAME = 'receivable_adjustment' AND original ->> 'kind' <> to_jsonb(NEW) ->> 'kind')
     OR coalesce(original ->> 'reverses_payment_id', original ->> 'reverses_adjustment_id') IS NOT NULL THEN
    RAISE EXCEPTION 'a reversal must mirror its original entry' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_payment_reversal ON payment;
CREATE TRIGGER trg_payment_reversal BEFORE INSERT ON payment
  FOR EACH ROW EXECUTE FUNCTION receivable_reversal_check();
DROP TRIGGER IF EXISTS trg_adjustment_reversal ON receivable_adjustment;
CREATE TRIGGER trg_adjustment_reversal BEFORE INSERT ON receivable_adjustment
  FOR EACH ROW EXECUTE FUNCTION receivable_reversal_check();

-- Rule 7: never deleted; only the export stamp and the "disputed" flag of a Kürzung may change.
CREATE OR REPLACE FUNCTION receivable_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% % cannot be deleted, record a reversal instead', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'exported_at' - 'disputed') IS DISTINCT FROM (to_jsonb(OLD) - 'exported_at' - 'disputed') THEN
    RAISE EXCEPTION '% % cannot be changed, record a reversal instead', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_payment_immutable ON payment;
CREATE TRIGGER trg_payment_immutable BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION receivable_immutable();
DROP TRIGGER IF EXISTS trg_adjustment_immutable ON receivable_adjustment;
CREATE TRIGGER trg_adjustment_immutable BEFORE UPDATE OR DELETE ON receivable_adjustment
  FOR EACH ROW EXECUTE FUNCTION receivable_immutable();
REVOKE DELETE ON payment, receivable_adjustment FROM opc_app;

-- Cancelled invoices take no new payments (0015) – but reversals of earlier entries are allowed.
CREATE OR REPLACE FUNCTION receivable_target_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d document;
  reversal boolean := coalesce(to_jsonb(NEW) ->> 'reverses_payment_id',
                               to_jsonb(NEW) ->> 'reverses_adjustment_id') IS NOT NULL;
BEGIN
  SELECT * INTO d FROM document WHERE id = NEW.invoice_id;
  IF d.type NOT IN ('invoice', 'credit_note') OR d.finalized_at IS NULL THEN
    RAISE EXCEPTION 'payments require a finalized invoice' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' AND d.status = 'cancelled' AND NOT reversal THEN
    RAISE EXCEPTION 'invoice % is cancelled, no payments can be booked on it', d.number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
