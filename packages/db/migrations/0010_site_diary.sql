-- 0010 Bautagebuch (daily site reports) and other reports: photos from the project filing,
-- signatures only for open reports, one open daily report per project and day.

-- Photos of a report are files of the same project's Ablage. After signing they are evidence
-- (file_guard keeps them unchanged) and the list of photos is fixed.
CREATE TABLE report_photo (
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  report_id   uuid NOT NULL REFERENCES report (id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES file (id) ON DELETE RESTRICT,
  caption     text CHECK (caption IS NULL OR length(caption) <= 500),
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, file_id)
);
SELECT enable_tenant_rls('report_photo');
SELECT add_audit_trigger('report_photo');

CREATE OR REPLACE FUNCTION report_photo_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  rid uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.report_id ELSE NEW.report_id END;
BEGIN
  SELECT status, project_id INTO r FROM report WHERE id = rid;
  -- Deleting a draft report removes its photo list (cascade); signed reports cannot be deleted.
  IF r.status IS NOT NULL AND r.status <> 'draft' THEN
    RAISE EXCEPTION 'photos of a completed report cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP <> 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM file f WHERE f.id = NEW.file_id AND f.project_id = r.project_id
  ) THEN
    RAISE EXCEPTION 'photo belongs to another project' USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER trg_report_photo_guard BEFORE INSERT OR UPDATE OR DELETE ON report_photo
  FOR EACH ROW EXECUTE FUNCTION report_photo_guard();

-- Signatures are only added while the report is still open (the signing transaction adds them
-- and then completes the report).
CREATE OR REPLACE FUNCTION report_signature_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM report WHERE id = NEW.report_id) <> 'draft' THEN
    RAISE EXCEPTION 'report is already signed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_report_signature_check BEFORE INSERT ON report_signature
  FOR EACH ROW EXECUTE FUNCTION report_signature_check();

-- The report data is an object keyed by section id.
ALTER TABLE report ADD CONSTRAINT report_data_object CHECK (jsonb_typeof(data) = 'object');

-- One open report per project, template and day (a signed day can get a supplementary report).
CREATE UNIQUE INDEX report_open_per_day_uq ON report (project_id, template_id, report_date)
  WHERE status = 'draft';
CREATE INDEX report_photo_file_idx ON report_photo (file_id);
