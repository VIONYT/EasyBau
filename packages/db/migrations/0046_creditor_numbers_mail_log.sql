-- C.9: Kreditorennummern aus einem Nummernkreis und Protokoll je E-Mail im Rechnungseingang.

-- ---------------------------------------------------------------------------------------------
-- Nummernkreis „Kreditoren“ (DATEV-Personenkonten der Lieferanten)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE number_sequence DROP CONSTRAINT IF EXISTS number_sequence_kind_check;
ALTER TABLE number_sequence ADD CONSTRAINT number_sequence_kind_check CHECK (kind IN (
  'contact', 'project', 'quote', 'cost_estimate', 'order_confirmation',
  'delivery_note', 'invoice', 'credit_note', 'creditor'));

-- DATEV: Kreditoren ab 70000 (5-stellige Personenkonten); 70000 bleibt der Sammelkreditor.
INSERT INTO number_sequence (tenant_id, kind, prefix, start_value, min_length, next_value, pattern)
SELECT id, 'creditor', '', 70001, 5, 70001, '{Nummer}' FROM tenant
ON CONFLICT (tenant_id, kind) DO NOTHING;

CREATE OR REPLACE FUNCTION number_in_use(p_kind text, p_number text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_kind = 'contact' THEN EXISTS (SELECT 1 FROM contact WHERE number = p_number)
    WHEN p_kind = 'creditor' THEN EXISTS (SELECT 1 FROM contact WHERE creditor_number = p_number)
    WHEN p_kind = 'project' THEN EXISTS (SELECT 1 FROM project WHERE number = p_number)
    WHEN p_kind IN ('invoice', 'credit_note') THEN EXISTS (
      SELECT 1 FROM document WHERE number = p_number AND type IN ('invoice', 'credit_note'))
    ELSE EXISTS (SELECT 1 FROM document WHERE number = p_number AND type = p_kind)
  END
$$;

-- New companies: wrap seed_tenant_defaults() again (0027 wrapped the 0005 version).
DO $$
BEGIN
  IF to_regprocedure('seed_tenant_defaults_0027()') IS NULL THEN
    ALTER FUNCTION seed_tenant_defaults() RENAME TO seed_tenant_defaults_0027;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION seed_tenant_defaults() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_tenant_defaults_0027();
  INSERT INTO number_sequence (tenant_id, kind, prefix, start_value, min_length, next_value, pattern)
  VALUES (current_tenant_id(), 'creditor', '', 70001, 5, 70001, '{Nummer}')
  ON CONFLICT (tenant_id, kind) DO NOTHING;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Protokoll je E-Mail (Rechnungseingang per E-Mail-Postfach)
-- ---------------------------------------------------------------------------------------------
-- One row per fetched e-mail: sender, subject and what happened to each attachment. Personal
-- data (sender address) → deleted after 90 days (purge_incoming_mail_log, worker job). The
-- invoices themselves stay as incoming_invoice with their own retention.
CREATE TABLE IF NOT EXISTS incoming_mail_log (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  mail_from    text CHECK (length(mail_from) <= 500),
  subject      text CHECK (length(subject) <= 500),
  -- done = processed (marked read/moved), retry = stays unread and is fetched again.
  outcome      text NOT NULL CHECK (outcome IN ('done', 'retry')),
  -- [{ filename, result: imported|duplicate|ignored|failed, incomingInvoiceId?, reason? }]
  attachments  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachments) = 'array')
);
SELECT enable_tenant_rls('incoming_mail_log');
CREATE INDEX IF NOT EXISTS incoming_mail_log_tenant_fetched_idx
  ON incoming_mail_log (tenant_id, fetched_at DESC, id DESC);

-- Runs for all companies (worker, without tenant context): deletes entries older than p_days.
CREATE OR REPLACE FUNCTION purge_incoming_mail_log(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'purge_incoming_mail_log: at least 30 days';
  END IF;
  DELETE FROM incoming_mail_log WHERE fetched_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION purge_incoming_mail_log(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_incoming_mail_log(integer) TO opc_app;
