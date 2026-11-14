-- 0033 Angebot (P2.12): Bild-Positionen aus der Projektablage, Angebotsversionen.

-- Bild-Position: the image is a file of the project's Ablage. The foreign key keeps the file as
-- long as a document uses it (a finalized document is never deleted, so its images stay).
ALTER TABLE document_item DROP CONSTRAINT IF EXISTS document_item_image_file_fk;
ALTER TABLE document_item ADD CONSTRAINT document_item_image_file_fk
  FOREIGN KEY (image_file_id) REFERENCES file (id);
ALTER TABLE document_item DROP CONSTRAINT IF EXISTS document_item_image_check;
ALTER TABLE document_item ADD CONSTRAINT document_item_image_check
  CHECK (position_type <> 'image' OR image_file_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS document_item_image_idx ON document_item (image_file_id)
  WHERE image_file_id IS NOT NULL;

-- Angebotsversionen: a new version is a new draft that points to the version it replaces
-- (number on finalizing: number of version 1 + "-V2" …). Older versions stay unchanged.
ALTER TABLE document ADD COLUMN IF NOT EXISTS previous_version_id uuid REFERENCES document (id);
CREATE UNIQUE INDEX IF NOT EXISTS document_previous_version_uq
  ON document (previous_version_id) WHERE previous_version_id IS NOT NULL;
