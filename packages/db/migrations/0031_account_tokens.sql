-- 0031 Konto (P2.10): Passwort vergessen, Zurücksetzen durch die Administration und
-- E-Mail-Bestätigung. One-time links carry a 256-bit random token; only its SHA-256 is stored
-- (a high-entropy token needs no slow hash – unlike passwords, which stay argon2id). Tokens are
-- short-lived and single-use; like sessions they belong to the login, not to a company.

CREATE TABLE account_token (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('password_reset', 'email_verify')),
  token_hash  bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  -- Address the link went to; a confirmation only counts while it is still the login's address.
  email       text NOT NULL,
  -- Administrator who created a reset link to hand over (NULL: requested by the person).
  created_by  uuid REFERENCES app_user (id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX account_token_user_idx ON account_token (user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX account_token_expires_idx ON account_token (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON account_token TO opc_app;

-- E-mails for these links (the body with the link is cleared once the SMTP server accepted it).
ALTER TABLE email_message DROP CONSTRAINT IF EXISTS email_message_kind_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_kind_check CHECK (kind IN (
  'invitation', 'test', 'document', 'dunning', 'password_reset', 'email_verify'));
