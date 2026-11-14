-- 0027 Eingangsrechnungen, Basisversion (P1.11; E-Rechnungs-Empfang ist seit 2025 Pflicht).
-- A received invoice (PDF, picture, ZUGFeRD PDF or XRechnung XML) is stored unchanged as an
-- original (document_artifact, archived WORM like every original) the moment it arrives. In the
-- review ("Zu prüfen") the data are entered or taken from the XML and the costs are allocated to
-- projects or business areas; "Prüfung bestätigen" freezes everything. Afterwards only the payment
-- status may change, and a mistake is handled by cancelling (Stornieren) – never by deleting.
-- Deliberately no bookkeeping: accounts appear only in the DATEV export.

-- ---------------------------------------------------------------------------------------------
-- Business areas (Betriebsbereiche): cost targets outside projects, per company, extendable.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_area (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  sort         integer NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT enable_tenant_rls('business_area');
SELECT add_audit_trigger('business_area');
SELECT add_updated_at_trigger('business_area');
REVOKE DELETE ON business_area FROM opc_app;

-- Defaults of DESIGN.md §2 for every existing company …
INSERT INTO business_area (tenant_id, name, sort)
SELECT t.id, v.name, v.sort
FROM tenant t
CROSS JOIN (VALUES ('Lager', 10), ('Büro', 20), ('Mitarbeitende', 30), ('Fahrzeuge', 40),
                   ('Werkstatt', 50), ('Sonstiges', 60)) AS v (name, sort)
ON CONFLICT (tenant_id, name) DO NOTHING;

-- … and for new ones: seed_tenant_defaults() (0005) is wrapped, so its body stays untouched.
DO $$
BEGIN
  IF to_regprocedure('seed_tenant_defaults_0005()') IS NULL THEN
    ALTER FUNCTION seed_tenant_defaults() RENAME TO seed_tenant_defaults_0005;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION seed_tenant_defaults() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t uuid := current_tenant_id();
BEGIN
  PERFORM seed_tenant_defaults_0005();
  INSERT INTO business_area (tenant_id, name, sort) VALUES
    (t, 'Lager', 10), (t, 'Büro', 20), (t, 'Mitarbeitende', 30), (t, 'Fahrzeuge', 40),
    (t, 'Werkstatt', 50), (t, 'Sonstiges', 60)
  ON CONFLICT (tenant_id, name) DO NOTHING;
  -- Tax advisors / auditors read incoming invoices too (Z1/Z2, DESIGN.md §5.3).
  UPDATE role SET permissions = array_append(permissions, 'incoming_invoice.read')
  WHERE tenant_id = t AND key = 'auditor' AND is_system
    AND NOT ('incoming_invoice.read' = ANY (permissions));
END
$$;

UPDATE role SET permissions = array_append(permissions, 'incoming_invoice.read')
WHERE key = 'auditor' AND is_system AND NOT ('incoming_invoice.read' = ANY (permissions));

-- ---------------------------------------------------------------------------------------------
-- Incoming invoice
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incoming_invoice (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id           uuid NOT NULL REFERENCES tenant (id),
  -- review = "Zu prüfen", confirmed = Prüfung bestätigt (frozen), discarded = verworfen before
  -- confirmation (e.g. not an invoice), cancelled = storniert after confirmation.
  status              text NOT NULL DEFAULT 'review'
                        CHECK (status IN ('review', 'confirmed', 'discarded', 'cancelled')),
  document_kind       text NOT NULL DEFAULT 'invoice' CHECK (document_kind IN ('invoice', 'credit_note')),
  -- What was received: pdf/image (data entered by hand) or an e-invoice (data from the XML).
  source              text NOT NULL
                        CHECK (source IN ('pdf', 'image', 'zugferd', 'xrechnung_cii', 'xrechnung_ubl')),
  filename            text NOT NULL,
  mime_type           text NOT NULL,
  sha256              bytea NOT NULL CHECK (length(sha256) = 32),
  size_bytes          bigint NOT NULL CHECK (size_bytes > 0),
  -- E-invoice: profile, KoSIT result (null = not checked) and the data read from the XML.
  einvoice_profile    text,
  einvoice_en16931    boolean,
  einvoice_valid      boolean,
  einvoice_messages   jsonb NOT NULL DEFAULT '[]',
  einvoice            jsonb,
  -- Reviewed data (snapshot of the supplier as on the invoice, rule 4).
  contact_id          uuid REFERENCES contact (id),
  supplier_name       text CHECK (length(supplier_name) <= 200),
  supplier_vat_id     text CHECK (length(supplier_vat_id) <= 30),
  supplier_tax_number text CHECK (length(supplier_tax_number) <= 30),
  supplier_address    text CHECK (length(supplier_address) <= 500),
  supplier_iban       text CHECK (length(supplier_iban) <= 34),
  invoice_number      text CHECK (length(invoice_number) <= 100),
  invoice_date        date,
  due_date            date,
  net_cents           bigint NOT NULL DEFAULT 0,
  tax_cents           bigint NOT NULL DEFAULT 0,
  gross_cents         bigint NOT NULL DEFAULT 0,
  -- § 13b UStG: the company owes the VAT (Kennzeichen für Voranmeldung und DATEV).
  reverse_charge      boolean NOT NULL DEFAULT false,
  note                text CHECK (length(note) <= 2000),
  received_at         timestamptz NOT NULL DEFAULT now(),
  uploaded_by         uuid REFERENCES app_user (id),
  confirmed_at        timestamptz,
  confirmed_by        uuid REFERENCES app_user (id),
  -- Zahlstatus (no bookkeeping): paid on a date, or open.
  paid_on             date,
  payment_note        text CHECK (length(payment_note) <= 500),
  closed_at           timestamptz,
  closed_by           uuid REFERENCES app_user (id),
  close_reason        text CHECK (length(close_reason) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('confirmed', 'cancelled')) = (confirmed_at IS NOT NULL)),
  CHECK ((status IN ('discarded', 'cancelled')) = (closed_at IS NOT NULL)),
  CHECK (paid_on IS NULL OR status IN ('confirmed', 'cancelled'))
);
SELECT enable_tenant_rls('incoming_invoice');
SELECT add_audit_trigger('incoming_invoice');
SELECT add_updated_at_trigger('incoming_invoice');
REVOKE DELETE ON incoming_invoice FROM opc_app;
-- The same file is received only once per company.
CREATE UNIQUE INDEX IF NOT EXISTS incoming_invoice_sha256_uq ON incoming_invoice (tenant_id, sha256);
CREATE INDEX IF NOT EXISTS incoming_invoice_list_idx
  ON incoming_invoice (tenant_id, status, invoice_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS incoming_invoice_number_idx
  ON incoming_invoice (tenant_id, lower(invoice_number));

-- VAT per rate (as printed on the invoice).
CREATE TABLE IF NOT EXISTS incoming_invoice_tax (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id            uuid NOT NULL REFERENCES tenant (id),
  incoming_invoice_id  uuid NOT NULL REFERENCES incoming_invoice (id),
  rate_percent         numeric(5, 2) NOT NULL CHECK (rate_percent >= 0 AND rate_percent < 100),
  net_cents            bigint NOT NULL,
  tax_cents            bigint NOT NULL,
  position             integer NOT NULL DEFAULT 0,
  UNIQUE (incoming_invoice_id, rate_percent)
);
SELECT enable_tenant_rls('incoming_invoice_tax');
SELECT add_audit_trigger('incoming_invoice_tax');

-- Kostenzuweisung: net amount per project or business area, cost type and VAT rate.
CREATE TABLE IF NOT EXISTS incoming_invoice_allocation (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id            uuid NOT NULL REFERENCES tenant (id),
  incoming_invoice_id  uuid NOT NULL REFERENCES incoming_invoice (id),
  project_id           uuid REFERENCES project (id),
  business_area_id     uuid REFERENCES business_area (id),
  cost_type            text NOT NULL
                         CHECK (cost_type IN ('material', 'labor', 'equipment', 'subcontract', 'other')),
  rate_percent         numeric(5, 2) NOT NULL CHECK (rate_percent >= 0 AND rate_percent < 100),
  net_cents            bigint NOT NULL CHECK (net_cents > 0),
  description          text CHECK (length(description) <= 500),
  position             integer NOT NULL DEFAULT 0,
  CHECK ((project_id IS NULL) <> (business_area_id IS NULL))
);
SELECT enable_tenant_rls('incoming_invoice_allocation');
SELECT add_audit_trigger('incoming_invoice_allocation');
CREATE INDEX IF NOT EXISTS incoming_invoice_allocation_invoice_idx
  ON incoming_invoice_allocation (incoming_invoice_id, position);
CREATE INDEX IF NOT EXISTS incoming_invoice_allocation_project_idx
  ON incoming_invoice_allocation (project_id) WHERE project_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Rules in the database (rule 2/7): frozen after "Prüfung bestätigen", never deleted.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION incoming_invoice_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Never changes: what was received.
  received text[] := ARRAY['id', 'tenant_id', 'source', 'filename', 'mime_type', 'sha256',
                           'size_bytes', 'einvoice_profile', 'einvoice_en16931', 'einvoice_valid',
                           'einvoice_messages', 'einvoice', 'received_at', 'uploaded_by', 'created_at'];
  -- May change on a confirmed invoice: payment status, cancellation.
  after_confirm text[] := ARRAY['paid_on', 'payment_note', 'status', 'closed_at', 'closed_by',
                                'close_reason', 'updated_at'];
  sums record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incoming invoice % cannot be deleted', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT bool_or(to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k) FROM unnest(received) k) THEN
    RAISE EXCEPTION 'the received original of incoming invoice % cannot be changed', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('discarded', 'cancelled') THEN
    RAISE EXCEPTION 'incoming invoice % is closed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'confirmed' THEN
    IF (to_jsonb(NEW) - after_confirm) IS DISTINCT FROM (to_jsonb(OLD) - after_confirm) THEN
      RAISE EXCEPTION 'incoming invoice % is confirmed and cannot be changed', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status NOT IN ('confirmed', 'cancelled') THEN
      RAISE EXCEPTION 'a confirmed incoming invoice can only be cancelled' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- review → confirmed: the sums must be complete (last line of defense behind the API check).
  IF NEW.status = 'confirmed' THEN
    SELECT (SELECT coalesce(sum(net_cents), 0) FROM incoming_invoice_tax WHERE incoming_invoice_id = NEW.id) AS tax_net,
           (SELECT coalesce(sum(tax_cents), 0) FROM incoming_invoice_tax WHERE incoming_invoice_id = NEW.id) AS tax_tax,
           (SELECT coalesce(sum(net_cents), 0) FROM incoming_invoice_allocation WHERE incoming_invoice_id = NEW.id) AS alloc_net,
           (SELECT count(*) FROM incoming_invoice_allocation WHERE incoming_invoice_id = NEW.id) AS allocations
      INTO sums;
    IF NEW.supplier_name IS NULL OR NEW.invoice_number IS NULL OR NEW.invoice_date IS NULL
       OR NEW.gross_cents <= 0 OR NEW.net_cents + NEW.tax_cents <> NEW.gross_cents
       OR sums.tax_net <> NEW.net_cents OR sums.tax_tax <> NEW.tax_cents
       OR sums.alloc_net <> NEW.net_cents OR sums.allocations = 0
       OR (NEW.reverse_charge AND NEW.tax_cents <> 0) THEN
      RAISE EXCEPTION 'incoming invoice % is incomplete and cannot be confirmed', NEW.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'only a confirmed incoming invoice can be cancelled' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_incoming_invoice_guard ON incoming_invoice;
CREATE TRIGGER trg_incoming_invoice_guard BEFORE UPDATE OR DELETE ON incoming_invoice
  FOR EACH ROW EXECUTE FUNCTION incoming_invoice_guard();

-- Tax lines and allocations change only while the invoice is being reviewed.
CREATE OR REPLACE FUNCTION incoming_invoice_child_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.incoming_invoice_id ELSE NEW.incoming_invoice_id END;
  state text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.incoming_invoice_id <> OLD.incoming_invoice_id THEN
    RAISE EXCEPTION 'cannot move % to another invoice', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  SELECT status INTO state FROM incoming_invoice WHERE id = parent;
  IF state IS DISTINCT FROM 'review' THEN
    RAISE EXCEPTION 'incoming invoice % is not in review, % cannot be changed', parent, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
DROP TRIGGER IF EXISTS trg_incoming_invoice_tax_guard ON incoming_invoice_tax;
CREATE TRIGGER trg_incoming_invoice_tax_guard BEFORE INSERT OR UPDATE OR DELETE ON incoming_invoice_tax
  FOR EACH ROW EXECUTE FUNCTION incoming_invoice_child_guard();
DROP TRIGGER IF EXISTS trg_incoming_invoice_allocation_guard ON incoming_invoice_allocation;
CREATE TRIGGER trg_incoming_invoice_allocation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON incoming_invoice_allocation
  FOR EACH ROW EXECUTE FUNCTION incoming_invoice_child_guard();

-- ---------------------------------------------------------------------------------------------
-- The received file is an original: document_artifact (insert-only, SHA-256, archived WORM by
-- the worker like every original, ADR 0008/0009).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE document_artifact ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE document_artifact
  ADD COLUMN IF NOT EXISTS incoming_invoice_id uuid REFERENCES incoming_invoice (id);
ALTER TABLE document_artifact DROP CONSTRAINT IF EXISTS document_artifact_kind_check;
ALTER TABLE document_artifact ADD CONSTRAINT document_artifact_kind_check CHECK (kind IN (
  'pdf', 'zugferd_pdf', 'zugferd_xml', 'xrechnung_xml', 'validation_report', 'attachment',
  'dunning_pdf', 'incoming_original'));
ALTER TABLE document_artifact DROP CONSTRAINT IF EXISTS document_artifact_owner;
ALTER TABLE document_artifact ADD CONSTRAINT document_artifact_owner CHECK (
  (document_id IS NULL) <> (incoming_invoice_id IS NULL)
  AND (kind = 'incoming_original') = (incoming_invoice_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS document_artifact_incoming_uq
  ON document_artifact (incoming_invoice_id) WHERE incoming_invoice_id IS NOT NULL;
