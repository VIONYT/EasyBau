-- 0052 Löschmarken im Belegarchiv (security audit run-1, ADR 0012 addendum): an older backup brings
-- back anonymised documents and erased contacts. Every anonymisation and erasure now leaves a small
-- marker that the worker writes into the WORM archive (outside the database, cannot be deleted by
-- the app). After a restore – and every night – the worker reads the markers and repeats what the
-- restored database lost, before the archive check could write purged originals back.

CREATE TABLE IF NOT EXISTS erasure_marker (
  tenant_id  uuid NOT NULL REFERENCES tenant (id),
  kind       text NOT NULL CHECK (kind IN ('document', 'contact')),
  ref_id     uuid NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  written_at timestamptz,
  PRIMARY KEY (kind, ref_id)
);
SELECT enable_tenant_rls('erasure_marker');
REVOKE UPDATE, DELETE ON erasure_marker FROM opc_app;

CREATE OR REPLACE FUNCTION erasure_marker_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO erasure_marker (tenant_id, kind, ref_id, payload)
  SELECT NEW.tenant_id, 'document', NEW.id,
         jsonb_build_object('number', p.number, 'approvedBy', p.approved_by,
                            'approvedAt', p.approved_at, 'retentionEnd', p.retention_end)
  FROM document_purge p WHERE p.document_id = NEW.id
  ON CONFLICT (kind, ref_id) DO NOTHING;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS erasure_marker_document ON document;
CREATE TRIGGER erasure_marker_document
  AFTER UPDATE OF purged_at ON document
  FOR EACH ROW WHEN (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL)
  EXECUTE FUNCTION erasure_marker_document();

CREATE OR REPLACE FUNCTION erasure_marker_contact() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO erasure_marker (tenant_id, kind, ref_id, payload)
  VALUES (NEW.tenant_id, 'contact', NEW.id, jsonb_build_object('erasedAt', NEW.erased_at))
  ON CONFLICT (kind, ref_id) DO NOTHING;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS erasure_marker_contact ON contact;
CREATE TRIGGER erasure_marker_contact
  AFTER UPDATE OF erased_at ON contact
  FOR EACH ROW WHEN (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL)
  EXECUTE FUNCTION erasure_marker_contact();

-- What was anonymised or erased before this migration gets its marker too.
INSERT INTO erasure_marker (tenant_id, kind, ref_id, payload)
SELECT d.tenant_id, 'document', d.id,
       jsonb_build_object('number', p.number, 'approvedBy', p.approved_by,
                          'approvedAt', p.approved_at, 'retentionEnd', p.retention_end)
FROM document d JOIN document_purge p ON p.document_id = d.id
WHERE d.purged_at IS NOT NULL
ON CONFLICT (kind, ref_id) DO NOTHING;
INSERT INTO erasure_marker (tenant_id, kind, ref_id, payload)
SELECT tenant_id, 'contact', id, jsonb_build_object('erasedAt', erased_at)
FROM contact WHERE erased_at IS NOT NULL
ON CONFLICT (kind, ref_id) DO NOTHING;

-- Worker (all companies): markers still to be written into the archive, and marking them.
CREATE OR REPLACE FUNCTION pending_erasure_markers(p_limit integer)
RETURNS TABLE (tenant_id uuid, kind text, ref_id uuid, payload jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.tenant_id, m.kind, m.ref_id, m.payload FROM erasure_marker m
  WHERE m.written_at IS NULL ORDER BY m.created_at LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION pending_erasure_markers(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pending_erasure_markers(integer) TO opc_app;

CREATE OR REPLACE FUNCTION erasure_marker_written(p_kind text, p_ref uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE erasure_marker SET written_at = now()
  WHERE kind = p_kind AND ref_id = p_ref AND written_at IS NULL
$$;
REVOKE ALL ON FUNCTION erasure_marker_written(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erasure_marker_written(text, uuid) TO opc_app;

-- Worker after a restore: which marked documents and contacts are back unerased (all companies).
CREATE OR REPLACE FUNCTION erasures_to_reapply(p_kinds text[], p_ids uuid[])
RETURNS TABLE (tenant_id uuid, kind text, ref_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.tenant_id, 'document', d.id
  FROM unnest(p_kinds, p_ids) AS m (kind, ref_id) JOIN document d ON d.id = m.ref_id
  WHERE m.kind = 'document' AND d.purged_at IS NULL
  UNION ALL
  SELECT c.tenant_id, 'contact', c.id
  FROM unnest(p_kinds, p_ids) AS m (kind, ref_id) JOIN contact c ON c.id = m.ref_id
  WHERE m.kind = 'contact' AND c.erased_at IS NULL
$$;
REVOKE ALL ON FUNCTION erasures_to_reapply(text[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erasures_to_reapply(text[], uuid[]) TO opc_app;
