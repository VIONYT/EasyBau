-- 0032 Einstellungen ergänzen (P2.11): Bundesland als Code (Feiertage), automatische Anhänge
-- (z. B. AGB an jedes Angebot) als unveränderliche Firmen-Dateien, E-Mail-Anhänge aus diesen
-- Dateien. Dokument-Vorgaben (§ 35a, Abschlagsart, Dateinamen, Anhänge) stehen in
-- tenant.settings -> 'documents' (Audit über den tenant-Trigger).

-- Federal state as ISO 3166-2 suffix (BW, BY, …); it selects the statutory holidays.
UPDATE tenant SET federal_state = NULL
WHERE federal_state IS NOT NULL AND federal_state NOT IN (
  'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH');
ALTER TABLE tenant DROP CONSTRAINT IF EXISTS tenant_federal_state_check;
ALTER TABLE tenant ADD CONSTRAINT tenant_federal_state_check CHECK (federal_state IN (
  'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'));

-- Own holidays only (Betriebsruhe, örtliche Feiertage); statutory ones are computed.
ALTER TABLE holiday ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS holiday_day_idx ON holiday (tenant_id, day);

-- Attachments (PDF) are company assets: insert-only like logos, so a sent e-mail can always be
-- traced to the exact file (Handelsbrief, 6 years).
ALTER TABLE tenant_asset ADD COLUMN IF NOT EXISTS name text CHECK (length(name) BETWEEN 1 AND 150);
ALTER TABLE tenant_asset DROP CONSTRAINT IF EXISTS tenant_asset_kind_check;
ALTER TABLE tenant_asset ADD CONSTRAINT tenant_asset_kind_check
  CHECK (kind IN ('logo', 'signature', 'attachment'));
ALTER TABLE tenant_asset DROP CONSTRAINT IF EXISTS tenant_asset_mime_type_check;
ALTER TABLE tenant_asset ADD CONSTRAINT tenant_asset_mime_type_check CHECK (
  (kind = 'attachment' AND mime_type = 'application/pdf')
  OR (kind <> 'attachment' AND mime_type IN ('image/png', 'image/jpeg', 'image/webp')));
ALTER TABLE tenant_asset DROP CONSTRAINT IF EXISTS tenant_asset_attachment_name;
ALTER TABLE tenant_asset ADD CONSTRAINT tenant_asset_attachment_name
  CHECK (kind <> 'attachment' OR name IS NOT NULL);

-- An e-mail attachment is either an archived original or a company file.
ALTER TABLE email_attachment ALTER COLUMN artifact_id DROP NOT NULL;
ALTER TABLE email_attachment ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES tenant_asset (id);
ALTER TABLE email_attachment DROP CONSTRAINT IF EXISTS email_attachment_source;
ALTER TABLE email_attachment ADD CONSTRAINT email_attachment_source
  CHECK ((artifact_id IS NULL) <> (asset_id IS NULL));

CREATE OR REPLACE FUNCTION email_message_attachments(p_message uuid)
RETURNS TABLE (filename text, storage_key text, mime_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.filename, coalesce(a.storage_key, t.storage_key), coalesce(a.mime_type, t.mime_type)
  FROM email_attachment e
  LEFT JOIN document_artifact a ON a.id = e.artifact_id
  LEFT JOIN tenant_asset t ON t.id = e.asset_id AND t.tenant_id = e.tenant_id
  JOIN email_message m ON m.id = e.email_message_id
  WHERE e.email_message_id = p_message AND m.status = 'sending'
  ORDER BY e.id
$$;
REVOKE ALL ON FUNCTION email_message_attachments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_message_attachments(uuid) TO opc_app;
