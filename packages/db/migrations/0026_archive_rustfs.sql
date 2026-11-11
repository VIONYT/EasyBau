-- 0026 Belegarchiv auf RustFS (ADR 0009, ersetzt MinIO aus ADR 0008): after the update the bundled
-- archive is a new, empty RustFS bucket. A complete reconciliation of every company with archived
-- originals writes them into it again – from the working copy, with their original retention date
-- (the former MinIO volume stays untouched; it can serve as ARCHIVE_PREVIOUS_S3_* source).
ALTER TABLE archive_verify_request DROP CONSTRAINT IF EXISTS archive_verify_request_reason_check;
ALTER TABLE archive_verify_request ADD CONSTRAINT archive_verify_request_reason_check
  CHECK (reason IN ('manual', 'restore', 'move'));

INSERT INTO archive_verify_request (tenant_id, reason)
SELECT DISTINCT r.tenant_id, 'move' FROM artifact_archive r
ON CONFLICT (tenant_id) WHERE finished_at IS NULL DO NOTHING;
