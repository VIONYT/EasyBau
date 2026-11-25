-- 0038 Betriebswarnung per E-Mail: the worker checks backup, off-site copy, audit chain and
-- WORM archive every morning and writes to the people with settings.write of each company when
-- something is wrong (packages/domain/src/operations-alert.ts).

ALTER TABLE email_message DROP CONSTRAINT IF EXISTS email_message_kind_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_kind_check CHECK (kind IN (
  'invitation', 'test', 'document', 'dunning', 'password_reset', 'email_verify',
  'operations_alert'));

-- What was reported last, per company: decides between "new problem → write now", "same problems
-- → again after 7 days" and "all clear → once". Operational data, not tax relevant.
CREATE TABLE IF NOT EXISTS operations_alert (
  tenant_id  uuid PRIMARY KEY REFERENCES tenant (id),
  problems   text[] NOT NULL DEFAULT '{}',
  sent_at    timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('operations_alert');
SELECT add_updated_at_trigger('operations_alert');
GRANT SELECT, INSERT, UPDATE ON operations_alert TO opc_app;

-- The worker runs without a signed-in person; this lists the companies to check.
CREATE OR REPLACE FUNCTION operations_alert_tenants()
RETURNS TABLE (tenant_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.name FROM tenant t ORDER BY t.created_at
$$;
REVOKE ALL ON FUNCTION operations_alert_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operations_alert_tenants() TO opc_app;
