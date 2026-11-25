-- 0040 Konto: eigene E-Mail-Adresse ändern (link to the new address, notice to the old one) and
-- security notices by e-mail (password changed, login from a new device).

ALTER TABLE account_token DROP CONSTRAINT IF EXISTS account_token_purpose_check;
ALTER TABLE account_token ADD CONSTRAINT account_token_purpose_check
  CHECK (purpose IN ('password_reset', 'email_verify', 'email_change'));

ALTER TABLE email_message DROP CONSTRAINT IF EXISTS email_message_kind_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_kind_check CHECK (kind IN (
  'invitation', 'test', 'document', 'dunning', 'password_reset', 'email_verify',
  'operations_alert', 'email_change', 'security_notice'));

-- Devices a person has logged in from: a long-lived random cookie, only its SHA-256 is stored.
-- A login from a device not in this list (and not the very first one) sends a notice. Like
-- sessions, devices belong to the login and not to a company (no RLS).
CREATE TABLE IF NOT EXISTS known_device (
  user_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  device_hash  bytea NOT NULL CHECK (length(device_hash) = 32),
  user_agent   text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_hash)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON known_device TO opc_app;
