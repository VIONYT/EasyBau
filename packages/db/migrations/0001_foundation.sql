-- 0001 Foundation: runtime role, helper functions, tenant context, audit log with hash chain.
-- Forward-only. Never edit after release; add a new migration instead (checksums are verified).

-- Runtime role: the application connects with the admin login but switches to this role
-- (startup parameter `role`). It is not a superuser and has no BYPASSRLS, so RLS always applies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'opc_app') THEN
    CREATE ROLE opc_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO opc_app;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- UUIDv7 (time-ordered). PostgreSQL 18 ships uuidv7(); this keeps us compatible with 17.
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  bytes bytea := uuid_send(gen_random_uuid());  -- 16 random bytes, no extension needed
BEGIN
  bytes := set_byte(bytes, 0, ((ms >> 40) & 255)::int);
  bytes := set_byte(bytes, 1, ((ms >> 32) & 255)::int);
  bytes := set_byte(bytes, 2, ((ms >> 24) & 255)::int);
  bytes := set_byte(bytes, 3, ((ms >> 16) & 255)::int);
  bytes := set_byte(bytes, 4, ((ms >> 8) & 255)::int);
  bytes := set_byte(bytes, 5, (ms & 255)::int);
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);  -- version 7
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);  -- RFC 4122 variant
  RETURN encode(bytes, 'hex')::uuid;
END
$$;

-- Current tenant from the transaction-local setting `app.tenant_id` (NULL if unset → no rows).
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Enables RLS (forced, also for the owner) with the standard tenant policy and grants for opc_app.
CREATE OR REPLACE FUNCTION enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
    tbl);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO opc_app', tbl);
END
$$;

-- Adds the updated_at trigger.
CREATE OR REPLACE FUNCTION add_updated_at_trigger(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON %s', tbl);
  EXECUTE format(
    'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()', tbl);
END
$$;

-- ---------------------------------------------------------------------------
-- Platform tables (not tenant data)
-- ---------------------------------------------------------------------------

CREATE TABLE tenant (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  legal_form    text,
  trade         text,                          -- Gewerk
  street        text,
  postal_code   text,
  city          text,
  country_code  char(2) NOT NULL DEFAULT 'DE',
  federal_state text,                          -- for holidays
  email         text,
  phone         text,
  website       text,
  vat_id        text,                          -- USt-IdNr.
  tax_number    text,                          -- Steuernummer
  register_court text,
  register_number text,
  manager_title text,
  manager_name  text,
  bank_name     text,
  iban_enc      bytea,                         -- encrypted by the application (AES-256-GCM)
  bic           text,
  logo_file_id  uuid,
  retention_years smallint NOT NULL DEFAULT 10 CHECK (retention_years BETWEEN 8 AND 30),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON tenant TO opc_app;
SELECT add_updated_at_trigger('tenant');

-- Users are global (one login can belong to several companies); access via membership.
CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  email           text NOT NULL,
  display_name    text NOT NULL,
  password_hash   text,                        -- argon2id; NULL for OIDC-only users
  totp_secret_enc bytea,
  is_active       boolean NOT NULL DEFAULT true,
  email_verified_at timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (lower(email));
GRANT SELECT, INSERT, UPDATE ON app_user TO opc_app;
SELECT add_updated_at_trigger('app_user');

CREATE TABLE user_session (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,          -- SHA-256 of the session token; token never stored
  active_tenant_id uuid REFERENCES tenant (id) ON DELETE CASCADE,  -- platform table, no RLS
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX user_session_user_idx ON user_session (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON user_session TO opc_app;

-- Generic rate limiting / login throttling in PostgreSQL (no Redis, ADR 0002).
CREATE TABLE rate_limit (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit TO opc_app;

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash chain per tenant (CLAUDE.md rule 6)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_event (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  seq         bigint NOT NULL,
  actor_user_id uuid,
  action      text NOT NULL,                   -- insert | update | delete | login | export | ...
  entity      text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash   bytea,
  hash        bytea NOT NULL,
  UNIQUE (tenant_id, seq)
);
SELECT enable_tenant_rls('audit_event');
REVOKE UPDATE, DELETE ON audit_event FROM opc_app;

CREATE OR REPLACE FUNCTION audit_event_hash(e audit_event) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(
    coalesce(e.prev_hash, ''::bytea) ||
    convert_to(
      jsonb_build_object(
        'tenant_id', e.tenant_id, 'seq', e.seq, 'actor', e.actor_user_id, 'action', e.action,
        'entity', e.entity, 'entity_id', e.entity_id, 'before', e.before, 'after', e.after,
        'created_at', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )::text,
      'UTF8'))
$$;

-- Fills seq / prev_hash / hash. Serialised per tenant with an advisory lock.
CREATE OR REPLACE FUNCTION audit_event_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last audit_event;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text, 0));
  SELECT * INTO last FROM audit_event
    WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last.seq, 0) + 1;
  NEW.prev_hash := last.hash;
  NEW.created_at := clock_timestamp();
  NEW.hash := audit_event_hash(NEW);
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_chain();

CREATE OR REPLACE FUNCTION reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'GoBD: audit records are immutable';
END
$$;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- Verifies the chain of one tenant. Returns the first broken seq, or NULL if intact.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  e audit_event;
  expected_prev bytea := NULL;
  expected_seq bigint := 1;
BEGIN
  FOR e IN SELECT * FROM audit_event WHERE tenant_id = p_tenant ORDER BY seq LOOP
    IF e.seq <> expected_seq
       OR e.prev_hash IS DISTINCT FROM expected_prev
       OR e.hash <> audit_event_hash(e) THEN
      RETURN e.seq;
    END IF;
    expected_prev := e.hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END
$$;

-- Generic row audit trigger for tax-relevant tables. Writes in the same transaction.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  row_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
BEGIN
  IF TG_OP = 'UPDATE' AND (row_new - 'updated_at') = (row_old - 'updated_at') THEN
    RETURN NEW;  -- no real change
  END IF;
  INSERT INTO audit_event (tenant_id, actor_user_id, action, entity, entity_id, before, after, hash)
  VALUES (
    coalesce((row_new ->> 'tenant_id')::uuid, (row_old ->> 'tenant_id')::uuid),
    current_app_user_id(),
    lower(TG_OP),
    TG_TABLE_NAME,
    coalesce((row_new ->> 'id')::uuid, (row_old ->> 'id')::uuid),
    row_old,
    row_new,
    ''::bytea);
  RETURN coalesce(NEW, OLD);
END
$$;

CREATE OR REPLACE FUNCTION add_audit_trigger(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON %s', tbl);
  EXECUTE format(
    'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
    tbl);
END
$$;

-- ---------------------------------------------------------------------------
-- Idempotency keys for POST endpoints (CLAUDE.md rule 10)
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_key (
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash  bytea NOT NULL,
  response_status smallint,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
SELECT enable_tenant_rls('idempotency_key');

-- ---------------------------------------------------------------------------
-- Gapless number sequences (CLAUDE.md rule 3)
-- ---------------------------------------------------------------------------

CREATE TABLE number_sequence (
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN (
                 'contact', 'project', 'quote', 'cost_estimate', 'order_confirmation',
                 'delivery_note', 'invoice', 'credit_note')),
  prefix       text NOT NULL DEFAULT '' CHECK (length(prefix) <= 20),
  start_value  bigint NOT NULL DEFAULT 1 CHECK (start_value >= 0),
  min_length   smallint NOT NULL DEFAULT 5 CHECK (min_length BETWEEN 1 AND 12),
  include_year boolean NOT NULL DEFAULT false,
  reset_yearly boolean NOT NULL DEFAULT false,
  current_year smallint,
  next_value   bigint NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);
SELECT enable_tenant_rls('number_sequence');
SELECT add_updated_at_trigger('number_sequence');

-- For invoices and credit notes the counter may only move forward (no reuse of numbers).
CREATE OR REPLACE FUNCTION number_sequence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind IN ('invoice', 'credit_note')
     AND NEW.next_value < OLD.next_value
     AND NEW.current_year IS NOT DISTINCT FROM OLD.current_year THEN
    RAISE EXCEPTION 'number sequence % must not be decreased', OLD.kind USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_number_sequence_guard BEFORE UPDATE ON number_sequence
  FOR EACH ROW EXECUTE FUNCTION number_sequence_guard();

-- Draws the next number inside the caller's transaction. A rollback releases nothing, so the
-- number is only consumed when the surrounding transaction (e.g. finalize) commits → gapless.
CREATE OR REPLACE FUNCTION next_number(p_kind text, p_date date DEFAULT current_date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  s number_sequence;
  y smallint := extract(year FROM p_date)::smallint;
  v bigint;
BEGIN
  SELECT * INTO s FROM number_sequence
    WHERE tenant_id = current_tenant_id() AND kind = p_kind
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no number sequence % for current tenant', p_kind USING ERRCODE = 'P0002';
  END IF;
  IF s.reset_yearly AND s.current_year IS DISTINCT FROM y THEN
    s.next_value := s.start_value;
  END IF;
  v := s.next_value;
  UPDATE number_sequence
    SET next_value = v + 1, current_year = y
    WHERE tenant_id = s.tenant_id AND kind = s.kind;
  RETURN s.prefix
    || CASE WHEN s.include_year THEN y::text || '-' ELSE '' END
    || lpad(v::text, s.min_length, '0');
END
$$;
