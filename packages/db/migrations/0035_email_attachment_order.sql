-- 0035 E-Mail-Anhänge in fester Reihenfolge: uuid_v7 is random within the same millisecond, so
-- ordering by id could put the company file (AGB) before the document. The position is the order
-- in which the attachments were queued (document first).
ALTER TABLE email_attachment ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION email_message_attachments(p_message uuid)
RETURNS TABLE (filename text, storage_key text, mime_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.filename, coalesce(a.storage_key, t.storage_key), coalesce(a.mime_type, t.mime_type)
  FROM email_attachment e
  LEFT JOIN document_artifact a ON a.id = e.artifact_id
  LEFT JOIN tenant_asset t ON t.id = e.asset_id AND t.tenant_id = e.tenant_id
  JOIN email_message m ON m.id = e.email_message_id
  WHERE e.email_message_id = p_message AND m.status = 'sending'
  ORDER BY e.position, e.id
$$;
REVOKE ALL ON FUNCTION email_message_attachments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_message_attachments(uuid) TO opc_app;
