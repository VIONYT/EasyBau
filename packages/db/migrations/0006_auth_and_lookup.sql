-- 0006 Authentication helpers and lookup columns.
--
-- A few platform questions must be answered before a tenant context exists (setup status,
-- memberships of a user at login). They are answered by narrow SECURITY DEFINER functions that
-- return only the minimum, instead of weakening RLS on the tables.

-- Is the instance already set up (at least one company)?
CREATE OR REPLACE FUNCTION instance_has_tenant() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant)
$$;
REVOKE ALL ON FUNCTION instance_has_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION instance_has_tenant() TO opc_app;

-- Companies a user belongs to, with role, for login and tenant switching.
CREATE OR REPLACE FUNCTION user_memberships(p_user uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, role_key text, role_name text, access text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, r.key, r.name, r.access
  FROM membership m
  JOIN tenant t ON t.id = m.tenant_id
  JOIN role r ON r.id = m.role_id
  WHERE m.user_id = p_user
    AND (m.valid_until IS NULL OR m.valid_until >= current_date)
  ORDER BY t.name
$$;
REVOKE ALL ON FUNCTION user_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_memberships(uuid) TO opc_app;

-- Sessions: idle timeout bookkeeping and second factor state.
ALTER TABLE user_session ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;
CREATE INDEX user_session_expires_idx ON user_session (expires_at);

-- TOTP: pending secret during enrolment, replay protection for used time steps.
ALTER TABLE app_user ADD COLUMN totp_pending_secret_enc bytea;
ALTER TABLE app_user ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE app_user ADD COLUMN totp_last_step bigint;
ALTER TABLE app_user ADD COLUMN failed_logins integer NOT NULL DEFAULT 0;
ALTER TABLE app_user ADD COLUMN locked_until timestamptz;

-- Sortable display name for contacts (list sorting and keyset pagination).
ALTER TABLE contact ADD COLUMN display_name text GENERATED ALWAYS AS (
  CASE WHEN kind = 'organization' THEN organization_name
       ELSE nullif(trim(coalesce(last_name, '') || ', ' || coalesce(first_name, ''), ', '), '')
  END
) STORED;
CREATE INDEX contact_display_name_idx ON contact (tenant_id, lower(display_name), id);
