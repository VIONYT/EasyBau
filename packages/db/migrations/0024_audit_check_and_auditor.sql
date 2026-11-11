-- 0024 Audit-Kette nachts prüfen (rule 6, DESIGN.md §4.7) and time-limited access for the
-- auditor role (Steuerberatung / Betriebsprüfung, GoBD Z1/Z2).

-- Result of every check of a company's audit chain (nightly by the worker or on request).
-- Each check anchors the newest event (seq + hash): a later check finds a chain that was cut off
-- at the end or recomputed completely, which the hash chain alone cannot show.
CREATE TABLE IF NOT EXISTS audit_chain_check (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  checked_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  origin      text NOT NULL CHECK (origin IN ('nightly', 'manual')),
  checked_by  uuid REFERENCES app_user (id),
  events      bigint NOT NULL,
  last_seq    bigint,
  last_hash   bytea,
  -- null = intact; broken = hash/sequence mismatch at broken_seq; truncated = events missing at
  -- the end; rewritten = the anchored event of the previous check has a different hash now.
  problem     text CHECK (problem IN ('broken', 'truncated', 'rewritten')),
  broken_seq  bigint
);
SELECT enable_tenant_rls('audit_chain_check');
REVOKE UPDATE, DELETE ON audit_chain_check FROM opc_app;
DROP TRIGGER IF EXISTS trg_audit_chain_check_immutable ON audit_chain_check;
CREATE TRIGGER trg_audit_chain_check_immutable BEFORE UPDATE OR DELETE ON audit_chain_check
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE INDEX IF NOT EXISTS audit_chain_check_tenant_idx ON audit_chain_check (tenant_id, checked_at DESC);

-- Checks the chain of one company and records the result. Runs with the caller's rights: in the
-- app only for the own company (RLS), for the nightly run via check_all_audit_chains().
CREATE OR REPLACE FUNCTION check_audit_chain(p_tenant uuid, p_origin text, p_user uuid)
RETURNS audit_chain_check
LANGUAGE plpgsql AS $$
DECLARE
  previous audit_chain_check;
  newest audit_event;
  anchored bytea;
  broken bigint;
  n bigint;
  result audit_chain_check;
BEGIN
  SELECT * INTO previous FROM audit_chain_check
    WHERE tenant_id = p_tenant AND last_seq IS NOT NULL ORDER BY checked_at DESC LIMIT 1;
  SELECT count(*) INTO n FROM audit_event WHERE tenant_id = p_tenant;
  SELECT * INTO newest FROM audit_event WHERE tenant_id = p_tenant ORDER BY seq DESC LIMIT 1;
  broken := verify_audit_chain(p_tenant);
  result.problem := NULL;
  IF broken IS NOT NULL THEN
    result.problem := 'broken';
    result.broken_seq := broken;
  ELSIF previous.id IS NOT NULL AND coalesce(newest.seq, 0) < previous.last_seq THEN
    result.problem := 'truncated';
    result.broken_seq := coalesce(newest.seq, 0) + 1;
  ELSIF previous.id IS NOT NULL THEN
    SELECT hash INTO anchored FROM audit_event WHERE tenant_id = p_tenant AND seq = previous.last_seq;
    IF anchored IS DISTINCT FROM previous.last_hash THEN
      result.problem := 'rewritten';
      result.broken_seq := previous.last_seq;
    END IF;
  END IF;
  INSERT INTO audit_chain_check (tenant_id, origin, checked_by, events, last_seq, last_hash,
                                 problem, broken_seq)
  VALUES (p_tenant, p_origin, p_user, n,
          -- A damaged chain keeps the last good anchor, so later checks still compare against it.
          CASE WHEN result.problem IS NULL THEN newest.seq ELSE previous.last_seq END,
          CASE WHEN result.problem IS NULL THEN newest.hash ELSE previous.last_hash END,
          result.problem, result.broken_seq)
  RETURNING * INTO result;
  RETURN result;
END
$$;

-- Nightly job of the worker (runtime role, all companies; no BYPASSRLS for the app user).
CREATE OR REPLACE FUNCTION check_all_audit_chains()
RETURNS TABLE (tenant_id uuid, events bigint, problem text, broken_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t record;
  r audit_chain_check;
BEGIN
  FOR t IN SELECT id FROM tenant ORDER BY id LOOP
    r := check_audit_chain(t.id, 'nightly', NULL);
    tenant_id := r.tenant_id;
    events := r.events;
    problem := r.problem;
    broken_seq := r.broken_seq;
    RETURN NEXT;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION check_all_audit_chains() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_all_audit_chains() TO opc_app;

-- ---------------------------------------------------------------------------
-- Auditor (Prüfer): access only for a limited time.
-- ---------------------------------------------------------------------------

ALTER TABLE invitation ADD COLUMN IF NOT EXISTS access_until date;

-- Existing auditor memberships without an end date get 30 days, then the access ends.
UPDATE membership m SET valid_until = current_date + 30
FROM role r
WHERE r.id = m.role_id AND r.key = 'auditor' AND m.valid_until IS NULL;

CREATE OR REPLACE FUNCTION membership_auditor_limited() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.valid_until IS NULL
     AND EXISTS (SELECT 1 FROM role WHERE id = NEW.role_id AND key = 'auditor') THEN
    RAISE EXCEPTION 'auditor access needs an end date (valid_until)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_membership_auditor_limited ON membership;
CREATE TRIGGER trg_membership_auditor_limited BEFORE INSERT OR UPDATE ON membership
  FOR EACH ROW EXECUTE FUNCTION membership_auditor_limited();

-- ---------------------------------------------------------------------------
-- Rule 6: company master data and tax settings are tax-relevant as well (name, address, tax
-- number, USt-IdNr., bank account, settings; tax rates; payment terms). The company row has no
-- tenant_id column, so it gets its own trigger function.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_tenant_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  row_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
BEGIN
  IF TG_OP = 'UPDATE' AND (row_new - 'updated_at') = (row_old - 'updated_at') THEN
    RETURN NEW;
  END IF;
  INSERT INTO audit_event (tenant_id, actor_user_id, action, entity, entity_id, before, after, hash)
  VALUES (coalesce(NEW.id, OLD.id), current_app_user_id(), lower(TG_OP), 'tenant',
          coalesce(NEW.id, OLD.id), row_old, row_new, ''::bytea);
  RETURN coalesce(NEW, OLD);
END
$$;
DROP TRIGGER IF EXISTS trg_audit ON tenant;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION audit_tenant_change();

SELECT add_audit_trigger('tax_rate');
SELECT add_audit_trigger('payment_term');
