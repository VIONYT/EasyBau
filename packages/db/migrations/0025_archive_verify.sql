-- 0025 Archiv-Abgleich (ADR 0008): archived originals are checked regularly in the WORM bucket
-- (HEAD: exists, SHA-256, size, retention; a sample also by content). Missing or damaged objects
-- are written again from the working copy (or the previous archive while moving to another S3)
-- with the original retention date. Every check is recorded (insert-only).

CREATE TABLE IF NOT EXISTS artifact_archive_check (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  artifact_id  uuid NOT NULL REFERENCES document_artifact (id),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  checked_at   timestamptz NOT NULL DEFAULT now(),
  bucket       text NOT NULL,
  -- Content downloaded and hashed (otherwise HEAD with the stored SHA-256 metadata only).
  deep         boolean NOT NULL DEFAULT false,
  -- ok | restored = written again | lost = damaged/missing and no intact source found
  result       text NOT NULL CHECK (result IN ('ok', 'restored', 'lost')),
  -- What was wrong: missing | sha256 | size | retention | content
  problem      text CHECK (problem IN ('missing', 'sha256', 'size', 'retention', 'content')),
  -- Where a restored object came from.
  source       text CHECK (source IN ('working_copy', 'previous_archive')),
  version_id   text,
  CHECK ((result = 'ok') = (problem IS NULL)),
  CHECK ((result = 'restored') = (source IS NOT NULL))
);
SELECT enable_tenant_rls('artifact_archive_check');
REVOKE UPDATE, DELETE ON artifact_archive_check FROM opc_app;
DROP TRIGGER IF EXISTS trg_artifact_archive_check_immutable ON artifact_archive_check;
CREATE TRIGGER trg_artifact_archive_check_immutable BEFORE UPDATE OR DELETE ON artifact_archive_check
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE INDEX IF NOT EXISTS artifact_archive_check_artifact_idx
  ON artifact_archive_check (artifact_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS artifact_archive_check_tenant_idx
  ON artifact_archive_check (tenant_id, checked_at DESC);

-- A complete reconciliation of one company (after a restore or on request).
CREATE TABLE IF NOT EXISTS archive_verify_request (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  reason        text NOT NULL CHECK (reason IN ('manual', 'restore')),
  requested_by  uuid REFERENCES app_user (id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  checked       integer NOT NULL DEFAULT 0,
  restored      integer NOT NULL DEFAULT 0,
  lost          integer NOT NULL DEFAULT 0
);
SELECT enable_tenant_rls('archive_verify_request');
-- At most one open request per company.
CREATE UNIQUE INDEX IF NOT EXISTS archive_verify_request_open_uq
  ON archive_verify_request (tenant_id) WHERE finished_at IS NULL;

-- Worker (runtime role, all companies): archived originals, least recently checked first.
-- p_tenant/p_before restrict to one company and to objects not checked since p_before.
CREATE OR REPLACE FUNCTION archive_verify_candidates(p_limit integer, p_tenant uuid, p_before timestamptz)
RETURNS TABLE (id uuid, tenant_id uuid, storage_key text, sha256 bytea, size_bytes bigint,
               mime_type text, locked_until date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.tenant_id, a.storage_key, a.sha256, a.size_bytes, a.mime_type, a.locked_until
  FROM artifact_archive r
  JOIN document_artifact a ON a.id = r.artifact_id
  LEFT JOIN LATERAL (
    SELECT max(c.checked_at) AS last FROM artifact_archive_check c WHERE c.artifact_id = a.id
  ) l ON true
  WHERE (p_tenant IS NULL OR a.tenant_id = p_tenant)
    AND (p_before IS NULL OR l.last IS NULL OR l.last < p_before)
  ORDER BY l.last NULLS FIRST, a.created_at
  LIMIT p_limit
$$;

-- Oldest open reconciliation request (claimed by setting started_at once).
CREATE OR REPLACE FUNCTION next_archive_verify_request()
RETURNS TABLE (id uuid, tenant_id uuid, started_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
    UPDATE archive_verify_request q SET started_at = coalesce(q.started_at, now())
    WHERE q.id = (SELECT o.id FROM archive_verify_request o WHERE o.finished_at IS NULL
                  ORDER BY o.requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING q.id, q.tenant_id, q.started_at;
END
$$;

REVOKE ALL ON FUNCTION archive_verify_candidates(integer, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION next_archive_verify_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_verify_candidates(integer, uuid, timestamptz) TO opc_app;
GRANT EXECUTE ON FUNCTION next_archive_verify_request() TO opc_app;

-- First complete reconciliation of every company with archived originals (baseline after the
-- update; also covers backups restored from before this migration).
INSERT INTO archive_verify_request (tenant_id, reason)
SELECT DISTINCT r.tenant_id, 'restore' FROM artifact_archive r
ON CONFLICT (tenant_id) WHERE finished_at IS NULL DO NOTHING;
