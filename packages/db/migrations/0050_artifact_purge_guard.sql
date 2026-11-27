-- 0050 The operator's WORM purge (infra/archive-purge.sh, RustFS root key) must only delete the
-- originals of anonymised documents (security audit run-1). artifact_purge is written by the
-- runtime role; its key, lock date and archive flag are now always taken from the immutable
-- document_artifact row, only the two "done" timestamps may change, and archive_purge_due()
-- reads the key from document_artifact of a document that really is anonymised.

CREATE OR REPLACE FUNCTION artifact_purge_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a document_artifact%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO a FROM document_artifact WHERE id = NEW.artifact_id;
    IF NOT FOUND OR a.document_id IS DISTINCT FROM NEW.document_id THEN
      RAISE EXCEPTION 'artifact_purge: artifact does not belong to the document' USING ERRCODE = 'P0001';
    END IF;
    NEW.tenant_id := a.tenant_id;
    NEW.storage_key := a.storage_key;
    NEW.locked_until := a.locked_until;
    NEW.archived := EXISTS (SELECT 1 FROM artifact_archive x WHERE x.artifact_id = a.id);
    RETURN NEW;
  END IF;
  IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.locked_until IS DISTINCT FROM OLD.locked_until OR NEW.archived IS DISTINCT FROM OLD.archived
     OR NEW.purged_at IS DISTINCT FROM OLD.purged_at
     OR (OLD.file_deleted_at IS NOT NULL AND NEW.file_deleted_at IS DISTINCT FROM OLD.file_deleted_at)
     OR (OLD.archive_deleted_at IS NOT NULL AND NEW.archive_deleted_at IS DISTINCT FROM OLD.archive_deleted_at) THEN
    RAISE EXCEPTION 'artifact_purge rows are fixed; only the done timestamps can be set once'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS artifact_purge_guard ON artifact_purge;
CREATE TRIGGER artifact_purge_guard BEFORE INSERT OR UPDATE ON artifact_purge
  FOR EACH ROW EXECUTE FUNCTION artifact_purge_guard();

CREATE OR REPLACE FUNCTION archive_purge_due()
RETURNS TABLE (artifact_id uuid, storage_key text, locked_until date)
LANGUAGE sql STABLE AS $$
  SELECT a.id, a.storage_key, a.locked_until
  FROM artifact_purge p
  JOIN document_artifact a ON a.id = p.artifact_id
  JOIN document d ON d.id = a.document_id
  WHERE d.purged_at IS NOT NULL AND p.archive_deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM artifact_archive x WHERE x.artifact_id = a.id)
    AND a.locked_until < current_date
  ORDER BY p.purged_at
$$;
REVOKE ALL ON FUNCTION archive_purge_due() FROM PUBLIC;
