-- 0043 Stundenlohnzettel (Regiebericht) – Fristen nach VOB/B § 15 Abs. 3: the day the report was
-- handed to the client. From it the 6 Werktage for the signed return run; the report stays
-- changeable until it is signed (report_guard is unchanged).
ALTER TABLE report ADD COLUMN IF NOT EXISTS submitted_on date;
