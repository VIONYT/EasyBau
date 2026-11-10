-- 0004 Files, measurements (Aufmaß), reports (Bautagebuch & Berichte), payments, dunning.

-- ---------------------------------------------------------------------------
-- Files (stored in S3/MinIO; the database holds metadata and hashes)
-- ---------------------------------------------------------------------------

CREATE TABLE file (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  project_id    uuid REFERENCES project (id) ON DELETE RESTRICT,
  folder        text NOT NULL DEFAULT '',
  filename      text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  sha256        bytea NOT NULL CHECK (length(sha256) = 32),
  storage_key   text NOT NULL UNIQUE,
  caption       text,
  taken_at      timestamptz,
  is_evidence   boolean NOT NULL DEFAULT false,   -- referenced by signed report / finalized invoice
  uploaded_by   uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('file');
CREATE INDEX file_project_idx ON file (project_id, folder);

CREATE OR REPLACE FUNCTION file_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_evidence THEN
    IF TG_OP = 'DELETE' OR NEW.sha256 <> OLD.sha256 OR NEW.storage_key <> OLD.storage_key
       OR NOT NEW.is_evidence THEN
      RAISE EXCEPTION 'file % is evidence and cannot be changed or deleted', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER trg_file_guard BEFORE UPDATE OR DELETE ON file
  FOR EACH ROW EXECUTE FUNCTION file_guard();

-- ---------------------------------------------------------------------------
-- Measurements (DESIGN.md §4.3, CLAUDE.md rules 11 & 12)
-- ---------------------------------------------------------------------------

CREATE TABLE measurement_sheet (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  project_id    uuid NOT NULL REFERENCES project (id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('survey', 'performance')),
  title         text NOT NULL,
  measured_on   date NOT NULL DEFAULT current_date,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
  signed_at     timestamptz,
  signed_by_contractor text,
  signed_by_client text,
  signature_file_id uuid REFERENCES file (id),
  is_inline     boolean NOT NULL DEFAULT false,  -- auto-created sheet behind "Aufmaß in der Position"
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'signed') = (signed_at IS NOT NULL))
);
SELECT enable_tenant_rls('measurement_sheet');
SELECT add_updated_at_trigger('measurement_sheet');
SELECT add_audit_trigger('measurement_sheet');
CREATE INDEX measurement_sheet_project_idx ON measurement_sheet (project_id);

CREATE OR REPLACE FUNCTION measurement_sheet_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'signed measurement sheet % is immutable', OLD.id
      USING ERRCODE = 'P0001', HINT = 'Create a new sheet that references this one';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER trg_measurement_sheet_guard BEFORE UPDATE OR DELETE ON measurement_sheet
  FOR EACH ROW EXECUTE FUNCTION measurement_sheet_guard();

CREATE TABLE measurement_location (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  sheet_id      uuid NOT NULL REFERENCES measurement_sheet (id) ON DELETE CASCADE,
  parent_id     uuid REFERENCES measurement_location (id) ON DELETE CASCADE,
  name          text NOT NULL,                  -- Haus A › EG › Bad
  variables     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"L": "4,25", "B": "3,10", "H": "2,60"}
  sort          integer NOT NULL DEFAULT 0
);
SELECT enable_tenant_rls('measurement_location');

CREATE TABLE measurement_line (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  sheet_id      uuid NOT NULL REFERENCES measurement_sheet (id) ON DELETE CASCADE,
  location_id   uuid REFERENCES measurement_location (id) ON DELETE SET NULL,
  document_item_id uuid REFERENCES document_item (id) ON DELETE SET NULL,
  sort          integer NOT NULL DEFAULT 0,
  description   text,
  formula       text NOT NULL CHECK (length(formula) BETWEEN 1 AND 500),
  variables     jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_qty    numeric(18,4) NOT NULL,          -- always recomputed by the server (rule 11)
  unit_id       uuid REFERENCES unit (id),
  is_deduction  boolean NOT NULL DEFAULT false,
  photo_file_id uuid REFERENCES file (id),
  corrects_line_id uuid REFERENCES measurement_line (id),
  locked_by_invoice_id uuid REFERENCES document (id),
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('measurement_line');
SELECT add_updated_at_trigger('measurement_line');
SELECT add_audit_trigger('measurement_line');
CREATE INDEX measurement_line_sheet_idx ON measurement_line (sheet_id, sort);
CREATE INDEX measurement_line_item_idx ON measurement_line (document_item_id);

-- Rule 12: lines used by a finalized invoice or on a signed sheet are immutable.
-- The only permitted change is locking an unlocked line (locked_by_invoice_id NULL → invoice).
CREATE OR REPLACE FUNCTION measurement_line_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sheet_status text;
  only_locking boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    only_locking := OLD.locked_by_invoice_id IS NULL AND NEW.locked_by_invoice_id IS NOT NULL
      AND (to_jsonb(NEW) - ARRAY['locked_by_invoice_id', 'updated_at'])
          = (to_jsonb(OLD) - ARRAY['locked_by_invoice_id', 'updated_at']);
    IF only_locking THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.locked_by_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'measurement line % is billed and cannot be changed', OLD.id
      USING ERRCODE = 'P0001', HINT = 'Add a correction line instead';
  END IF;

  SELECT status INTO sheet_status FROM measurement_sheet
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.sheet_id ELSE NEW.sheet_id END;
  IF sheet_status = 'signed' THEN
    RAISE EXCEPTION 'measurement sheet is signed; lines cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER trg_measurement_line_guard BEFORE INSERT OR UPDATE OR DELETE ON measurement_line
  FOR EACH ROW EXECUTE FUNCTION measurement_line_guard();

-- ---------------------------------------------------------------------------
-- Reports (DESIGN.md §4.5)
-- ---------------------------------------------------------------------------

CREATE TABLE report_template (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  key           text NOT NULL,
  name          text NOT NULL,
  billable      boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  is_system     boolean NOT NULL DEFAULT false,
  sections      jsonb NOT NULL,                  -- ordered list of section definitions
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  CHECK (jsonb_typeof(sections) = 'array')
);
SELECT enable_tenant_rls('report_template');
SELECT add_updated_at_trigger('report_template');

CREATE TABLE report (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  project_id    uuid NOT NULL REFERENCES project (id) ON DELETE RESTRICT,
  template_id   uuid NOT NULL REFERENCES report_template (id),
  report_date   date NOT NULL DEFAULT current_date,
  service_from  date,
  service_to    date,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed', 'signed')),
  header_snapshot jsonb,                         -- contractor, client, place of performance
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- section values keyed by section id
  template_snapshot jsonb,                       -- template sections at completion time
  billed_in_invoice_id uuid REFERENCES document (id),
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
SELECT enable_tenant_rls('report');
SELECT add_updated_at_trigger('report');
SELECT add_audit_trigger('report');
CREATE INDEX report_project_idx ON report (project_id, report_date DESC);

CREATE OR REPLACE FUNCTION report_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'signed' OR OLD.billed_in_invoice_id IS NOT NULL THEN
    -- Allow only marking a signed report as billed.
    IF TG_OP = 'UPDATE' AND OLD.billed_in_invoice_id IS NULL AND NEW.billed_in_invoice_id IS NOT NULL
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
CREATE TRIGGER trg_report_guard BEFORE UPDATE OR DELETE ON report
  FOR EACH ROW EXECUTE FUNCTION report_guard();

CREATE TABLE report_signature (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  report_id     uuid NOT NULL REFERENCES report (id) ON DELETE RESTRICT,
  signer_name   text NOT NULL,
  signer_role   text NOT NULL CHECK (signer_role IN ('contractor', 'client', 'other')),
  image_file_id uuid REFERENCES file (id),
  signed_at     timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('report_signature');
SELECT add_audit_trigger('report_signature');
CREATE TRIGGER trg_report_signature_immutable BEFORE UPDATE OR DELETE ON report_signature
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------
-- Payments, receivable adjustments, dunning (DESIGN.md §4.6)
-- ---------------------------------------------------------------------------

CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  invoice_id    uuid NOT NULL REFERENCES document (id) ON DELETE RESTRICT,
  paid_on       date NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),
  method        text NOT NULL DEFAULT 'transfer' CHECK (method IN ('transfer', 'cash', 'card', 'direct_debit', 'other')),
  reference     text,
  reverses_payment_id uuid REFERENCES payment (id),
  exported_at   timestamptz,                    -- DATEV export; afterwards only counter-bookings
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('payment');
SELECT add_audit_trigger('payment');
CREATE INDEX payment_invoice_idx ON payment (invoice_id);

CREATE TABLE receivable_adjustment (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  invoice_id    uuid NOT NULL REFERENCES document (id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('cash_discount', 'retention', 'bank_fee', 'short_payment', 'other')),
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),
  reason        text,
  disputed      boolean NOT NULL DEFAULT false,
  exported_at   timestamptz,
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('short_payment', 'other') OR reason IS NOT NULL)
);
SELECT enable_tenant_rls('receivable_adjustment');
SELECT add_audit_trigger('receivable_adjustment');
CREATE INDEX receivable_adjustment_invoice_idx ON receivable_adjustment (invoice_id);

CREATE OR REPLACE FUNCTION exported_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.exported_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'exported_at') IS DISTINCT FROM (to_jsonb(OLD) - 'exported_at') THEN
      RAISE EXCEPTION '% % was exported and cannot be changed', TG_TABLE_NAME, OLD.id
        USING ERRCODE = 'P0001', HINT = 'Record a counter-booking instead';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER trg_payment_exported BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION exported_guard();
CREATE TRIGGER trg_adjustment_exported BEFORE UPDATE OR DELETE ON receivable_adjustment
  FOR EACH ROW EXECUTE FUNCTION exported_guard();

-- Payments and adjustments only for finalized invoices / credit notes.
CREATE OR REPLACE FUNCTION receivable_target_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d document;
BEGIN
  SELECT * INTO d FROM document WHERE id = NEW.invoice_id;
  IF d.type NOT IN ('invoice', 'credit_note') OR d.finalized_at IS NULL THEN
    RAISE EXCEPTION 'payments require a finalized invoice' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_payment_target BEFORE INSERT OR UPDATE ON payment
  FOR EACH ROW EXECUTE FUNCTION receivable_target_guard();
CREATE TRIGGER trg_adjustment_target BEFORE INSERT OR UPDATE ON receivable_adjustment
  FOR EACH ROW EXECUTE FUNCTION receivable_target_guard();

CREATE TABLE dunning_notice (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  invoice_id    uuid NOT NULL REFERENCES document (id) ON DELETE RESTRICT,
  level         text NOT NULL CHECK (level IN ('reminder', 'first', 'final')),
  notice_date   date NOT NULL DEFAULT current_date,
  due_date      date NOT NULL,
  fee_cents     bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),       -- no VAT on fees
  interest_rate_percent numeric(7,4) NOT NULL DEFAULT 0,
  interest_cents bigint NOT NULL DEFAULT 0 CHECK (interest_cents >= 0),
  flat_fee_cents bigint NOT NULL DEFAULT 0 CHECK (flat_fee_cents >= 0),  -- § 288 Abs. 5 BGB
  open_amount_cents bigint NOT NULL,
  letter_snapshot jsonb,
  sent_at       timestamptz,
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, level)
);
SELECT enable_tenant_rls('dunning_notice');
SELECT add_audit_trigger('dunning_notice');

-- Levels must follow each other: reminder → first → final.
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
    RAISE EXCEPTION 'sent dunning notice % cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;

CREATE OR REPLACE FUNCTION receivable_target_check(p_invoice uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM document WHERE id = p_invoice AND type = 'invoice' AND finalized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'dunning requires a finalized invoice' USING ERRCODE = 'P0001';
  END IF;
END
$$;
CREATE TRIGGER trg_dunning_guard BEFORE INSERT OR UPDATE OR DELETE ON dunning_notice
  FOR EACH ROW EXECUTE FUNCTION dunning_guard();

-- Open amount of an invoice = gross − payments − adjustments (never negative in the view).
CREATE VIEW invoice_balance WITH (security_invoker = true) AS
SELECT
  d.id AS invoice_id,
  d.tenant_id,
  d.gross_total_cents,
  coalesce(p.paid, 0) AS paid_cents,
  coalesce(a.adjusted, 0) AS adjusted_cents,
  d.gross_total_cents - coalesce(p.paid, 0) - coalesce(a.adjusted, 0) AS open_amount_cents
FROM document d
LEFT JOIN (SELECT invoice_id, sum(amount_cents) AS paid FROM payment GROUP BY invoice_id) p ON p.invoice_id = d.id
LEFT JOIN (SELECT invoice_id, sum(amount_cents) AS adjusted FROM receivable_adjustment GROUP BY invoice_id) a ON a.invoice_id = d.id
WHERE d.type IN ('invoice', 'credit_note') AND d.finalized_at IS NOT NULL;
GRANT SELECT ON invoice_balance TO opc_app;
