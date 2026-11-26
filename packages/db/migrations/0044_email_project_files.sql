-- 0044 E-Mail-Anhänge aus der Projektablage (Pläne, Aufmaßblatt- und Bericht-PDFs): an attachment is
-- an archived original, a company file or a file of the project. A file that was sent by e-mail is
-- kept (the e-mail is correspondence of the company): deleting it is refused by the foreign key.
ALTER TABLE email_attachment ADD COLUMN IF NOT EXISTS file_id uuid REFERENCES file (id) ON DELETE RESTRICT;
ALTER TABLE email_attachment DROP CONSTRAINT IF EXISTS email_attachment_source;
ALTER TABLE email_attachment ADD CONSTRAINT email_attachment_source
  CHECK (num_nonnulls(artifact_id, asset_id, file_id) = 1);
CREATE INDEX IF NOT EXISTS email_attachment_file_idx ON email_attachment (file_id) WHERE file_id IS NOT NULL;

CREATE OR REPLACE FUNCTION email_message_attachments(p_message uuid)
RETURNS TABLE (filename text, storage_key text, mime_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.filename, coalesce(a.storage_key, t.storage_key, f.storage_key),
         coalesce(a.mime_type, t.mime_type, f.mime_type)
  FROM email_attachment e
  LEFT JOIN document_artifact a ON a.id = e.artifact_id
  LEFT JOIN tenant_asset t ON t.id = e.asset_id AND t.tenant_id = e.tenant_id
  LEFT JOIN file f ON f.id = e.file_id AND f.tenant_id = e.tenant_id
  JOIN email_message m ON m.id = e.email_message_id
  WHERE e.email_message_id = p_message AND m.status = 'sending'
  ORDER BY e.position, e.id
$$;
REVOKE ALL ON FUNCTION email_message_attachments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_message_attachments(uuid) TO opc_app;
