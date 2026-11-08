-- 0007 User management (invitations) and WebAuthn security keys / passkeys (e.g. YubiKey).

-- ---------------------------------------------------------------------------
-- Invitations: an admin invites a person by e-mail; the link contains a random token
-- (only its SHA-256 is stored). Accepting creates the login and the membership.
-- ---------------------------------------------------------------------------
CREATE TABLE invitation (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  email        text NOT NULL,
  display_name text,
  role_id      uuid NOT NULL REFERENCES role (id),
  token_hash   bytea NOT NULL UNIQUE,
  invited_by   uuid REFERENCES app_user (id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES app_user (id),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('invitation');
SELECT add_audit_trigger('invitation');
CREATE UNIQUE INDEX invitation_open_uq ON invitation (tenant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The invitee is not logged in yet, so the invitation is looked up by token hash.
-- Returns only what the acceptance page needs.
CREATE OR REPLACE FUNCTION invitation_by_token(p_token_hash bytea)
RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, email text, display_name text,
               role_name text, expired boolean, closed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.tenant_id, t.name, i.email, i.display_name, r.name,
         i.expires_at < now(), (i.accepted_at IS NOT NULL OR i.revoked_at IS NOT NULL)
  FROM invitation i
  JOIN tenant t ON t.id = i.tenant_id
  JOIN role r ON r.id = i.role_id
  WHERE i.token_hash = p_token_hash
$$;
REVOKE ALL ON FUNCTION invitation_by_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_by_token(bytea) TO opc_app;

-- Membership changes are security relevant: keep at least one admin per company.
CREATE OR REPLACE FUNCTION membership_keep_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  admin_role uuid;
  remaining integer;
BEGIN
  SELECT id INTO admin_role FROM role WHERE tenant_id = OLD.tenant_id AND key = 'admin';
  IF OLD.role_id = admin_role AND (TG_OP = 'DELETE' OR NEW.role_id <> admin_role) THEN
    SELECT count(*) INTO remaining FROM membership
      WHERE tenant_id = OLD.tenant_id AND role_id = admin_role AND user_id <> OLD.user_id;
    IF remaining = 0 THEN
      RAISE EXCEPTION 'the last admin of a company cannot be removed' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER trg_membership_keep_admin BEFORE UPDATE OR DELETE ON membership
  FOR EACH ROW EXECUTE FUNCTION membership_keep_admin();
GRANT UPDATE ON membership TO opc_app;

-- ---------------------------------------------------------------------------
-- WebAuthn credentials (FIDO2 security keys such as YubiKey, platform passkeys).
-- Platform table: a credential belongs to a user, not to a company.
-- ---------------------------------------------------------------------------
CREATE TABLE webauthn_credential (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id        uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  credential_id  text NOT NULL UNIQUE,            -- base64url
  public_key     bytea NOT NULL,                  -- COSE public key
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  device_type    text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up      boolean NOT NULL DEFAULT false,
  aaguid         text,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);
CREATE INDEX webauthn_credential_user_idx ON webauthn_credential (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON webauthn_credential TO opc_app;

-- Short-lived challenges and pending logins (password correct, second factor outstanding).
CREATE TABLE auth_challenge (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  token_hash   bytea NOT NULL UNIQUE,             -- SHA-256 of the cookie value
  purpose      text NOT NULL CHECK (purpose IN ('mfa_login', 'passkey_login', 'webauthn_register')),
  user_id      uuid REFERENCES app_user (id) ON DELETE CASCADE,
  requested_tenant_id uuid REFERENCES tenant (id) ON DELETE CASCADE,  -- platform table, no RLS
  challenge    text,                              -- current WebAuthn challenge (base64url)
  attempts     smallint NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenge_expires_idx ON auth_challenge (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_challenge TO opc_app;
