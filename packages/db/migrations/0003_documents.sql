-- 0003 Documents: quotes, cost estimates, order confirmations, change orders, delivery notes,
-- invoices, credit notes. GoBD immutability is enforced here (CLAUDE.md rules 2–4).

CREATE TABLE document (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  project_id       uuid NOT NULL REFERENCES project (id) ON DELETE RESTRICT,
  type             text NOT NULL CHECK (type IN (
                     'quote', 'cost_estimate', 'order_confirmation', 'change_order',
                     'delivery_note', 'invoice', 'credit_note')),
  invoice_kind     text CHECK (invoice_kind IN ('standard', 'partial', 'progress', 'final', 'cancellation')),
  progress_no      smallint CHECK (progress_no > 0),             -- „2. Abschlagsrechnung“
  progress_billing_mode text CHECK (progress_billing_mode IN ('cumulative', 'individual')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN (
                     'draft', 'finalized', 'sent', 'accepted', 'partially_accepted', 'rejected', 'cancelled')),
  number           text,
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  subject          text,
  document_date    date NOT NULL DEFAULT current_date,
  service_from     date,
  service_to       date,
  place_of_performance text,
  contact_id       uuid REFERENCES contact (id),
  contact_person_id uuid REFERENCES contact (id),
  -- Snapshots taken at finalization (rule 4); finalized documents never read live master data.
  recipient_snapshot jsonb,
  issuer_snapshot  jsonb,
  tax_mode         text NOT NULL DEFAULT 'standard' CHECK (tax_mode IN (
                     'standard', 'reverse_charge_13b', 'small_business', 'intra_eu', 'export')),
  currency         char(3) NOT NULL DEFAULT 'EUR',
  intro_text       text,
  closing_text     text,
  payment_due_days smallint CHECK (payment_due_days BETWEEN 0 AND 365),
  cash_discount_percent numeric(7,4),
  cash_discount_days smallint,
  due_date         date,
  discount_percent numeric(7,4) CHECK (discount_percent >= 0 AND discount_percent <= 100),
  retention_percent numeric(7,4) CHECK (retention_percent >= 0 AND retention_percent <= 100),
  construction_levy_percent numeric(7,4) CHECK (construction_levy_percent >= 0 AND construction_levy_percent <= 100),
  show_labor_share boolean NOT NULL DEFAULT false,               -- § 35a EStG
  labor_share_cents bigint,
  net_total_cents  bigint NOT NULL DEFAULT 0,
  tax_total_cents  bigint NOT NULL DEFAULT 0,
  gross_total_cents bigint NOT NULL DEFAULT 0,
  payable_cents    bigint,                                        -- after deductions (final invoice)
  source_document_id uuid REFERENCES document (id),
  cancels_document_id uuid REFERENCES document (id),
  cancel_reason    text,
  finalized_at     timestamptz,
  finalized_by     uuid REFERENCES app_user (id),
  content_hash     bytea,                                         -- SHA-256 of canonical content
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user (id),
  CHECK ((type IN ('invoice', 'credit_note')) = (invoice_kind IS NOT NULL) OR type = 'credit_note'),
  CHECK (invoice_kind IS DISTINCT FROM 'progress' OR progress_no IS NOT NULL),
  CHECK ((invoice_kind = 'cancellation') = (cancels_document_id IS NOT NULL)),
  CHECK (service_to IS NULL OR service_from IS NULL OR service_to >= service_from),
  -- A finalized document always has number, snapshots and hash; a draft never has a number.
  CHECK (
    (finalized_at IS NULL AND number IS NULL AND content_hash IS NULL AND status = 'draft')
    OR (finalized_at IS NOT NULL AND number IS NOT NULL AND content_hash IS NOT NULL
        AND recipient_snapshot IS NOT NULL AND issuer_snapshot IS NOT NULL AND status <> 'draft')
  )
);
SELECT enable_tenant_rls('document');
SELECT add_updated_at_trigger('document');
SELECT add_audit_trigger('document');
CREATE UNIQUE INDEX document_number_uq ON document (tenant_id, type, number) WHERE number IS NOT NULL;
CREATE INDEX document_project_idx ON document (project_id, type);
CREATE INDEX document_open_idx ON document (tenant_id, due_date) WHERE type = 'invoice' AND status IN ('finalized', 'sent');
CREATE UNIQUE INDEX document_one_cancellation_uq ON document (cancels_document_id) WHERE cancels_document_id IS NOT NULL;

-- Rule 2: finalized documents are immutable. Only workflow fields may change afterwards.
CREATE OR REPLACE FUNCTION document_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable_after_finalize constant text[] := ARRAY['status', 'sent_at', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.finalized_at IS NOT NULL THEN
      RAISE EXCEPTION 'finalized document % cannot be deleted', OLD.number
        USING ERRCODE = 'P0001', HINT = 'GoBD: cancel the document instead';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.finalized_at IS NOT NULL THEN
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
CREATE TRIGGER trg_document_immutable BEFORE UPDATE OR DELETE ON document
  FOR EACH ROW EXECUTE FUNCTION document_immutable();

-- Children of a finalized document can neither be added, changed nor removed.
CREATE OR REPLACE FUNCTION guard_finalized_document_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  doc_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  finalized timestamptz;
BEGIN
  SELECT finalized_at INTO finalized FROM document WHERE id = doc_id;
  IF finalized IS NOT NULL THEN
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

CREATE OR REPLACE FUNCTION add_document_child_guard(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER trg_finalized_guard BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION guard_finalized_document_child()',
    tbl);
END
$$;

CREATE TABLE document_item (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  document_id      uuid NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  parent_id        uuid REFERENCES document_item (id) ON DELETE CASCADE,
  sort             integer NOT NULL DEFAULT 0,
  position_type    text NOT NULL CHECK (position_type IN (
                     'title', 'item', 'alternative', 'optional', 'lump_sum', 'text', 'subtotal', 'image')),
  oz               text,                                          -- Ordnungszahl, e.g. "2.1" or "N01.0010"
  quantity         numeric(18,4),
  unit_id          uuid REFERENCES unit (id),
  unit_symbol      text,                                          -- snapshot
  unit_unece_code  text,                                          -- snapshot for e-invoice BT-130
  short_text       text,
  long_text        text,
  show_long_text   boolean NOT NULL DEFAULT true,
  calc_mode        text CHECK (calc_mode IN ('unit_price', 'total_price')),
  unit_price_cents bigint,
  discount_percent numeric(7,4) CHECK (discount_percent >= 0 AND discount_percent <= 100),
  total_cents      bigint,
  tax_rate_percent numeric(7,4),
  tax_category     text CHECK (tax_category IN ('S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M')),
  quantity_from_measurement boolean NOT NULL DEFAULT false,
  cumulative_quantity numeric(18,4),                              -- invoices: measured to date
  previously_billed_quantity numeric(18,4),                       -- invoices: already invoiced
  catalog_item_id  uuid REFERENCES catalog_item (id) ON DELETE SET NULL,
  source_item_id   uuid REFERENCES document_item (id) ON DELETE SET NULL,
  image_file_id    uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (position_type NOT IN ('item', 'alternative', 'optional', 'lump_sum')
         OR (quantity IS NOT NULL AND unit_id IS NOT NULL AND short_text IS NOT NULL))
);
SELECT enable_tenant_rls('document_item');
SELECT add_updated_at_trigger('document_item');
SELECT add_audit_trigger('document_item');
SELECT add_document_child_guard('document_item');
CREATE INDEX document_item_document_idx ON document_item (document_id, sort);

CREATE TABLE item_calc_component (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  document_id      uuid NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  document_item_id uuid NOT NULL REFERENCES document_item (id) ON DELETE CASCADE,
  sort             integer NOT NULL DEFAULT 0,
  cost_kind        text NOT NULL CHECK (cost_kind IN ('labor', 'material', 'equipment', 'subcontract', 'other')),
  quantity         numeric(18,4) NOT NULL DEFAULT 1,
  unit_id          uuid REFERENCES unit (id),
  description      text,
  unit_cost_cents  bigint NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  markup_percent   numeric(7,4) NOT NULL DEFAULT 0,
  wage_group_id    uuid REFERENCES wage_group (id),
  catalog_item_id  uuid REFERENCES catalog_item (id) ON DELETE SET NULL
);
SELECT enable_tenant_rls('item_calc_component');
SELECT add_document_child_guard('item_calc_component');
CREATE INDEX item_calc_component_item_idx ON item_calc_component (document_item_id);

CREATE TABLE document_tax_line (
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  document_id    uuid NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  tax_category   text NOT NULL,
  rate_percent   numeric(7,4) NOT NULL,
  net_cents      bigint NOT NULL,
  tax_cents      bigint NOT NULL,
  exemption_reason text,
  PRIMARY KEY (document_id, tax_category, rate_percent)
);
SELECT enable_tenant_rls('document_tax_line');
SELECT add_document_child_guard('document_tax_line');

-- Final invoice: deducted progress invoices with their tax amounts (§ 14 Abs. 5 UStG, DESIGN.md §4.1).
CREATE TABLE document_deduction (
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  document_id      uuid NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  deducted_document_id uuid NOT NULL REFERENCES document (id),
  net_cents        bigint NOT NULL,
  tax_cents        bigint NOT NULL,
  gross_cents      bigint NOT NULL,
  PRIMARY KEY (document_id, deducted_document_id),
  CHECK (document_id <> deducted_document_id)
);
SELECT enable_tenant_rls('document_deduction');
SELECT add_document_child_guard('document_deduction');

-- Archived originals (PDF/A-3, XRechnung XML). Insert-only, never changed (rule 8).
CREATE TABLE document_artifact (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  document_id   uuid NOT NULL REFERENCES document (id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('pdf', 'zugferd_pdf', 'xrechnung_xml', 'attachment')),
  storage_key   text NOT NULL,
  sha256        bytea NOT NULL CHECK (length(sha256) = 32),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  mime_type     text NOT NULL,
  validated_at  timestamptz,                                      -- KoSIT validation passed
  locked_until  date NOT NULL,                                    -- end of retention period
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('document_artifact');
REVOKE UPDATE, DELETE ON document_artifact FROM opc_app;
SELECT add_audit_trigger('document_artifact');
CREATE TRIGGER trg_artifact_immutable BEFORE UPDATE OR DELETE ON document_artifact
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------
-- Change orders (Nachträge, DESIGN.md §4.4)
-- ---------------------------------------------------------------------------

CREATE TABLE change_order_meta (
  document_id      uuid PRIMARY KEY REFERENCES document (id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  contract_document_id uuid NOT NULL REFERENCES document (id),
  number           smallint NOT NULL CHECK (number > 0),          -- N01, N02 … per project
  basis            text NOT NULL CHECK (basis IN (
                     'changed_work', 'additional_work', 'quantity_variance', 'bgb_650b', 'other')),
  reason           text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN (
                     'draft', 'offered', 'accepted', 'partially_accepted', 'rejected')),
  offered_at       timestamptz,
  decided_at       timestamptz,
  decided_by_name  text,
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,            -- refs to reports, files, measurement lines
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('accepted', 'partially_accepted', 'rejected') OR decided_at IS NOT NULL)
);
SELECT enable_tenant_rls('change_order_meta');
SELECT add_updated_at_trigger('change_order_meta');
SELECT add_audit_trigger('change_order_meta');
CREATE UNIQUE INDEX change_order_number_uq ON change_order_meta (contract_document_id, number);

-- Per accepted change order item: whether the client accepted it (partial acceptance).
CREATE TABLE change_order_item_decision (
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  document_item_id uuid PRIMARY KEY REFERENCES document_item (id) ON DELETE CASCADE,
  accepted         boolean NOT NULL
);
SELECT enable_tenant_rls('change_order_item_decision');
SELECT add_audit_trigger('change_order_item_decision');
