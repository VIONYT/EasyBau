-- 0041 Kontakte zusammenführen: a duplicate is merged into the contact that stays. Everything that
-- may still change moves over (projects, drafts, contact persons, channels and addresses the
-- target lacks, incoming invoices under review); finalised documents and confirmed incoming
-- invoices keep pointing at the duplicate (rule 2/4 – they carry their own snapshot). The
-- duplicate stays archived with a pointer to the target and is not changed any more.

ALTER TABLE contact ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES contact (id);
ALTER TABLE contact DROP CONSTRAINT IF EXISTS contact_merged_into_ck;
ALTER TABLE contact ADD CONSTRAINT contact_merged_into_ck
  CHECK (merged_into_id IS NULL OR (merged_into_id <> id AND archived_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS contact_merged_into_idx ON contact (merged_into_id)
  WHERE merged_into_id IS NOT NULL;
