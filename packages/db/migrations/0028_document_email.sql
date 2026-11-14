-- 0028 Dokumente per E-Mail (P2.1): an outbox message can belong to a document (Angebot,
-- Auftragsbestätigung, Nachtrag, Rechnung, Gutschrift …) and carries CC/BCC recipients. The
-- archived originals go along as attachments (email_attachment, 0023). Once the SMTP server has
-- accepted the message, the document is marked as sent ("versendet") – in the same statement that
-- finishes the message, written to the audit trail with the person who queued it.

ALTER TABLE email_message
  ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES document (id),
  ADD COLUMN IF NOT EXISTS cc_addresses text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS bcc_addresses text[] NOT NULL DEFAULT '{}';
ALTER TABLE email_message DROP CONSTRAINT IF EXISTS email_message_recipients_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_recipients_check
  CHECK (cardinality(cc_addresses) <= 10 AND cardinality(bcc_addresses) <= 10);
ALTER TABLE email_message DROP CONSTRAINT IF EXISTS email_message_document_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_document_check
  CHECK (kind <> 'document' OR document_id IS NOT NULL) NOT VALID;
CREATE INDEX IF NOT EXISTS email_message_document_idx ON email_message (document_id, created_at DESC)
  WHERE document_id IS NOT NULL;

-- The result type changes (CC/BCC), so the function is dropped and created again.
DROP FUNCTION IF EXISTS claim_email_messages(integer);
CREATE FUNCTION claim_email_messages(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, to_address text, reply_to text, subject text, body_text text,
               attempts smallint, cc_addresses text[], bcc_addresses text[])
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
    RETURNING m.id, m.tenant_id, m.to_address, m.reply_to, m.subject, m.body_text, m.attempts,
              m.cc_addresses, m.bcc_addresses;
END
$$;
REVOKE ALL ON FUNCTION claim_email_messages(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_email_messages(integer) TO opc_app;

CREATE OR REPLACE FUNCTION finish_email_message(p_id uuid, p_ok boolean, p_error text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m email_message;
BEGIN
  IF p_ok THEN
    UPDATE email_message SET status = 'sent', sent_at = now(), body_text = NULL, last_error = NULL
      WHERE id = p_id RETURNING * INTO m;
    -- Document sent: finalized → sent (accepted, rejected or cancelled documents keep their status).
    IF m.document_id IS NOT NULL THEN
      PERFORM set_config('app.tenant_id', m.tenant_id::text, true);
      PERFORM set_config('app.user_id', coalesce(m.created_by::text, ''), true);
      UPDATE document SET status = 'sent', sent_at = coalesce(sent_at, now())
        WHERE id = m.document_id AND status = 'finalized';
      UPDATE change_order_meta SET status = 'offered', offered_at = coalesce(offered_at, now())
        WHERE document_id = m.document_id AND status = 'draft';
      UPDATE document SET sent_at = now()
        WHERE id = m.document_id AND sent_at IS NULL AND status <> 'draft';
    END IF;
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
REVOKE ALL ON FUNCTION finish_email_message(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finish_email_message(uuid, boolean, text) TO opc_app;
