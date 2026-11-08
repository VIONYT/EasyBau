-- 0008 Project filing (Ablage): folder template per company, folders per project, files in folders.
-- Files themselves live in the object store (ADR 0004); the database holds metadata and hashes.

-- Ablage-Ordnerstruktur (Einstellungen › Layout & Texte): copied into every new project.
CREATE TABLE filing_template (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT enable_tenant_rls('filing_template');
CREATE UNIQUE INDEX filing_template_name_uq ON filing_template (tenant_id, lower(name));

CREATE TABLE project_folder (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES project (id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES app_user (id)
);
SELECT enable_tenant_rls('project_folder');
SELECT add_audit_trigger('project_folder');
CREATE UNIQUE INDEX project_folder_name_uq ON project_folder (project_id, lower(name));

-- Files: the free-text folder becomes a real folder reference.
ALTER TABLE file DROP COLUMN folder;
ALTER TABLE file ADD COLUMN folder_id uuid REFERENCES project_folder (id) ON DELETE RESTRICT;
ALTER TABLE file ADD CONSTRAINT file_folder_needs_project CHECK (folder_id IS NULL OR project_id IS NOT NULL);
CREATE INDEX file_project_idx ON file (project_id, folder_id, created_at DESC);
SELECT add_audit_trigger('file');

-- A file's folder must belong to the same project.
CREATE OR REPLACE FUNCTION file_folder_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM project_folder f WHERE f.id = NEW.folder_id AND f.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'folder % does not belong to project %', NEW.folder_id, NEW.project_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_file_folder_check BEFORE INSERT OR UPDATE OF folder_id, project_id ON file
  FOR EACH ROW EXECUTE FUNCTION file_folder_check();

-- Progress invoices are numbered per project: „1. Abschlagsrechnung“, „2. …“.
CREATE UNIQUE INDEX document_progress_no_uq ON document (project_id, progress_no)
  WHERE invoice_kind = 'progress';

-- Default folder structure for a company (called by the setup wizard, idempotent).
CREATE OR REPLACE FUNCTION seed_filing_defaults() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t uuid := current_tenant_id();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'seed_filing_defaults requires app.tenant_id' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM filing_template WHERE tenant_id = t) THEN
    RETURN;
  END IF;
  INSERT INTO filing_template (tenant_id, name, sort) VALUES
    (t, 'Pläne', 10),
    (t, 'Fotos', 20),
    (t, 'Verträge & Angebote', 30),
    (t, 'Schriftverkehr', 40),
    (t, 'Genehmigungen & Nachweise', 50),
    (t, 'Sonstiges', 60);
END
$$;

-- Existing companies get the default structure; existing projects get folders from it.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    PERFORM seed_filing_defaults();
    INSERT INTO project_folder (tenant_id, project_id, name, sort)
      SELECT p.tenant_id, p.id, ft.name, ft.sort
      FROM project p JOIN filing_template ft ON ft.tenant_id = p.tenant_id
      WHERE p.tenant_id = t.id
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
