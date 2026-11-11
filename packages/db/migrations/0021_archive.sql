-- 0021 Revisionssicheres Belegarchiv (ADR 0008, rule 8, GoBD): every document_artifact (PDF/A,
-- ZUGFeRD PDF, XRechnung/CII XML, KoSIT report) is copied once into an S3 bucket with Object Lock
-- (WORM) and a retention date. The working copy stays in the "files" volume; artifact_archive records
-- the archived object (insert-only). The worker archives pending artifacts of all companies.

CREATE TABLE IF NOT EXISTS artifact_archive (
  artifact_id    uuid PRIMARY KEY REFERENCES document_artifact (id),
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  bucket         text NOT NULL,
  object_key     text NOT NULL,
  version_id     text,
  sha256         bytea NOT NULL CHECK (length(sha256) = 32),
  retain_until   timestamptz NOT NULL,
  retention_mode text NOT NULL CHECK (retention_mode IN ('COMPLIANCE', 'GOVERNANCE')),
  archived_at    timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('artifact_archive');
SELECT add_audit_trigger('artifact_archive');
REVOKE UPDATE, DELETE ON artifact_archive FROM opc_app;
DROP TRIGGER IF EXISTS trg_artifact_archive_immutable ON artifact_archive;
CREATE TRIGGER trg_artifact_archive_immutable BEFORE UPDATE OR DELETE ON artifact_archive
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- The archived object must be the artifact: same company, same SHA-256, retention not shorter.
CREATE OR REPLACE FUNCTION artifact_archive_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a document_artifact%ROWTYPE;
BEGIN
  SELECT * INTO a FROM document_artifact WHERE id = NEW.artifact_id;
  IF a.id IS NULL OR a.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'archived artifact % not found', NEW.artifact_id USING ERRCODE = 'P0001';
  END IF;
  IF a.sha256 <> NEW.sha256 THEN
    RAISE EXCEPTION 'archived object of % has a different SHA-256', NEW.artifact_id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.retain_until < a.locked_until::timestamptz THEN
    RAISE EXCEPTION 'retention of % ends before the retention period', NEW.artifact_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_artifact_archive_check ON artifact_archive;
CREATE TRIGGER trg_artifact_archive_check BEFORE INSERT ON artifact_archive
  FOR EACH ROW EXECUTE FUNCTION artifact_archive_check();

-- Failed attempts (e.g. archive not reachable): retried with growing pause.
CREATE TABLE IF NOT EXISTS artifact_archive_attempt (
  artifact_id     uuid PRIMARY KEY REFERENCES document_artifact (id),
  tenant_id       uuid NOT NULL REFERENCES tenant (id),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('artifact_archive_attempt');
SELECT add_updated_at_trigger('artifact_archive_attempt');

-- Worker (runtime role, all companies): artifacts not yet archived and due for an attempt.
CREATE OR REPLACE FUNCTION pending_archive_artifacts(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, storage_key text, sha256 bytea, size_bytes bigint,
               mime_type text, locked_until date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.tenant_id, a.storage_key, a.sha256, a.size_bytes, a.mime_type, a.locked_until
  FROM document_artifact a
  LEFT JOIN artifact_archive_attempt t ON t.artifact_id = a.id
  WHERE NOT EXISTS (SELECT 1 FROM artifact_archive r WHERE r.artifact_id = a.id)
    AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= now())
  ORDER BY a.created_at
  LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION archive_attempt_failed(p_artifact uuid, p_error text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO artifact_archive_attempt (artifact_id, tenant_id, attempts, last_error, next_attempt_at)
  SELECT a.id, a.tenant_id, 1, left(p_error, 500), now() + interval '1 minute'
  FROM document_artifact a WHERE a.id = p_artifact
  ON CONFLICT (artifact_id) DO UPDATE SET
    attempts = artifact_archive_attempt.attempts + 1,
    last_error = left(p_error, 500),
    -- 1, 2, 4 … minutes, at most 6 hours
    next_attempt_at = now() + least(interval '6 hours',
      interval '1 minute' * power(2, least(artifact_archive_attempt.attempts, 9)));
END
$$;

REVOKE ALL ON FUNCTION pending_archive_artifacts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_attempt_failed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pending_archive_artifacts(integer) TO opc_app;
GRANT EXECUTE ON FUNCTION archive_attempt_failed(uuid, text) TO opc_app;
