-- 0013 E-mail outbox: messages are written in the same transaction as the change that causes
-- them (e.g. an invitation) and sent by the worker with retries. SMTP is optional.

CREATE TABLE email_message (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('invitation', 'test', 'document')),
  to_address    text NOT NULL CHECK (length(to_address) BETWEEN 3 AND 254),
  reply_to      text,
  subject       text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  -- Cleared after sending: invitation links must not stay readable in the database.
  body_text     text,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts      smallint NOT NULL DEFAULT 0,
  last_error    text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
SELECT enable_tenant_rls('email_message');
CREATE INDEX email_message_queue_idx ON email_message (next_attempt_at) WHERE status IN ('queued', 'sending');
CREATE INDEX email_message_tenant_idx ON email_message (tenant_id, created_at DESC);

-- The worker sends for all companies; these two functions are its only access (no BYPASSRLS).
CREATE OR REPLACE FUNCTION claim_email_messages(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, to_address text, reply_to text, subject text, body_text text, attempts smallint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Messages stuck in "sending" (worker crashed) are retried.
  UPDATE email_message m SET status = 'queued'
    WHERE m.status = 'sending' AND m.next_attempt_at < now() - interval '10 minutes';
  RETURN QUERY
    UPDATE email_message m SET status = 'sending', attempts = m.attempts + 1, next_attempt_at = now()
    WHERE m.id IN (
      SELECT q.id FROM email_message q
      WHERE q.status = 'queued' AND q.next_attempt_at <= now()
      ORDER BY q.created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
    RETURNING m.id, m.tenant_id, m.to_address, m.reply_to, m.subject, m.body_text, m.attempts;
END
$$;

CREATE OR REPLACE FUNCTION finish_email_message(p_id uuid, p_ok boolean, p_error text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_ok THEN
    UPDATE email_message SET status = 'sent', sent_at = now(), body_text = NULL, last_error = NULL
      WHERE id = p_id;
  ELSE
    -- Up to 5 attempts with growing pauses (1, 4, 9, 16 minutes), then "failed".
    UPDATE email_message SET
      status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
      body_text = CASE WHEN attempts >= 5 THEN NULL ELSE body_text END,
      last_error = left(p_error, 500),
      next_attempt_at = now() + make_interval(mins => attempts * attempts)
      WHERE id = p_id;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION claim_email_messages(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_email_message(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_email_messages(integer) TO opc_app;
GRANT EXECUTE ON FUNCTION finish_email_message(uuid, boolean, text) TO opc_app;
