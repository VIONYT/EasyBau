-- 0034 Eingangsrechnungen ausbauen (P2.4): Rechnungseingang per E-Mail-Postfach, Kostenzuweisung
-- je Rechnungsposition, Kreditorennummern der Lieferanten.

-- How the invoice arrived; for e-mail: sender and subject (shown in the review).
ALTER TABLE incoming_invoice ADD COLUMN IF NOT EXISTS received_via text NOT NULL DEFAULT 'upload'
  CHECK (received_via IN ('upload', 'email'));
ALTER TABLE incoming_invoice ADD COLUMN IF NOT EXISTS email_from text CHECK (length(email_from) <= 300);
ALTER TABLE incoming_invoice ADD COLUMN IF NOT EXISTS email_subject text CHECK (length(email_subject) <= 500);

-- The guard of 0027 freezes what was received; the new columns belong to it.
CREATE OR REPLACE FUNCTION incoming_invoice_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  received text[] := ARRAY['id', 'tenant_id', 'source', 'filename', 'mime_type', 'sha256',
                           'size_bytes', 'einvoice_profile', 'einvoice_en16931', 'einvoice_valid',
                           'einvoice_messages', 'einvoice', 'received_at', 'uploaded_by', 'created_at',
                           'received_via', 'email_from', 'email_subject'];
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

-- Kostenzuweisung je Rechnungsposition: the line of the e-invoice (BT-126 Positionsnummer).
ALTER TABLE incoming_invoice_allocation ADD COLUMN IF NOT EXISTS line_id text
  CHECK (length(line_id) <= 100);

-- Kreditorennummer (DATEV Personenkonto) of a supplier; replaces the Sammelkreditor in the export.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS creditor_number text CHECK (creditor_number ~ '^[0-9]{5,9}$');
CREATE UNIQUE INDEX IF NOT EXISTS contact_creditor_number_uq
  ON contact (tenant_id, creditor_number) WHERE creditor_number IS NOT NULL;

-- Rechnungseingang per E-Mail: the poller (runtime role, all companies) needs to know which
-- companies have a mailbox. Only tenant id and the mailbox settings, nothing else.
CREATE OR REPLACE FUNCTION incoming_mailbox_tenants()
RETURNS TABLE (tenant_id uuid, mailbox jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.settings -> 'incomingMail'
  FROM tenant t
  WHERE coalesce((t.settings -> 'incomingMail' ->> 'enabled')::boolean, false)
$$;
REVOKE ALL ON FUNCTION incoming_mailbox_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION incoming_mailbox_tenants() TO opc_app;
