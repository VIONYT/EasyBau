-- 0009 Measurements (Aufmaß) always belong to exactly one project: everything a sheet refers to
-- (rooms, LV positions, photos, corrected lines) must come from the same project.
-- Reports (Bautagebuch) already require a project (report.project_id NOT NULL).

-- Rooms: parent in the same sheet; no changes once the sheet is signed (gemeinsames Aufmaß).
CREATE OR REPLACE FUNCTION measurement_location_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sheet uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.sheet_id ELSE NEW.sheet_id END;
BEGIN
  IF (SELECT status FROM measurement_sheet WHERE id = sheet) = 'signed' THEN
    RAISE EXCEPTION 'measurement sheet is signed; rooms cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_OP = 'UPDATE' AND NEW.sheet_id <> OLD.sheet_id THEN
      RAISE EXCEPTION 'rooms cannot be moved to another sheet' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM measurement_location p WHERE p.id = NEW.parent_id AND p.sheet_id = NEW.sheet_id
    ) THEN
      RAISE EXCEPTION 'parent room belongs to another sheet' USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(NEW.variables) <> 'object' THEN
      RAISE EXCEPTION 'room variables must be an object' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER trg_measurement_location_guard BEFORE INSERT OR UPDATE OR DELETE ON measurement_location
  FOR EACH ROW EXECUTE FUNCTION measurement_location_guard();

-- Lines: room of the same sheet, LV position / photo / corrected line of the same project.
CREATE OR REPLACE FUNCTION measurement_line_refs_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sheet_project uuid;
BEGIN
  SELECT project_id INTO sheet_project FROM measurement_sheet WHERE id = NEW.sheet_id;
  IF TG_OP = 'UPDATE' AND NEW.sheet_id <> OLD.sheet_id THEN
    RAISE EXCEPTION 'lines cannot be moved to another sheet' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM measurement_location l WHERE l.id = NEW.location_id AND l.sheet_id = NEW.sheet_id
  ) THEN
    RAISE EXCEPTION 'room belongs to another sheet' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.document_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_item i JOIN document d ON d.id = i.document_id
    WHERE i.id = NEW.document_item_id AND d.project_id = sheet_project
  ) THEN
    RAISE EXCEPTION 'LV position belongs to another project' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.photo_file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM file f WHERE f.id = NEW.photo_file_id AND f.project_id = sheet_project
  ) THEN
    RAISE EXCEPTION 'photo belongs to another project' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.corrects_line_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM measurement_line c JOIN measurement_sheet s ON s.id = c.sheet_id
    WHERE c.id = NEW.corrects_line_id AND s.project_id = sheet_project
  ) THEN
    RAISE EXCEPTION 'corrected line belongs to another project' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(NEW.variables) <> 'object' THEN
    RAISE EXCEPTION 'line variables must be an object' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_measurement_line_refs BEFORE INSERT OR UPDATE ON measurement_line
  FOR EACH ROW EXECUTE FUNCTION measurement_line_refs_check();

-- A sheet never moves to another project.
CREATE OR REPLACE FUNCTION keep_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION '% cannot be moved to another project', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_measurement_sheet_keep_project BEFORE UPDATE OF project_id ON measurement_sheet
  FOR EACH ROW EXECUTE FUNCTION keep_project();
CREATE TRIGGER trg_report_keep_project BEFORE UPDATE OF project_id ON report
  FOR EACH ROW EXECUTE FUNCTION keep_project();
CREATE TRIGGER trg_document_keep_project BEFORE UPDATE OF project_id ON document
  FOR EACH ROW EXECUTE FUNCTION keep_project();

-- One automatic sheet per project and kind behind „Aufmaß in der Position“.
CREATE UNIQUE INDEX measurement_sheet_inline_uq ON measurement_sheet (project_id, kind) WHERE is_inline;
CREATE INDEX measurement_location_sheet_idx ON measurement_location (sheet_id, sort);
