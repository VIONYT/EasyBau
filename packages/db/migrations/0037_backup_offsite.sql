-- 0037 Sicherung außer Haus (ADR 0011): the backup service copies every local backup encrypted
-- with restic to a second location and records the result at the backup run. off = not set up.
ALTER TABLE backup_run ADD COLUMN IF NOT EXISTS offsite_status text
  CHECK (offsite_status IN ('ok', 'failed', 'off'));
ALTER TABLE backup_run ADD COLUMN IF NOT EXISTS offsite_at timestamptz;
-- Target without credentials, e.g. s3:s3.eu-central-1.example.com/firma-sicherung.
ALTER TABLE backup_run ADD COLUMN IF NOT EXISTS offsite_target text;
ALTER TABLE backup_run ADD COLUMN IF NOT EXISTS offsite_message text;
