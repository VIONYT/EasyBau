-- 0045 Anschrift je Dokument: which address of the recipient a draft uses (e.g. the delivery or
-- another billing address); empty = Rechnungsempfänger, else Hauptanschrift. No foreign key: the
-- finalised document carries its own snapshot, and a removed address simply falls back.
ALTER TABLE document ADD COLUMN IF NOT EXISTS recipient_address_id uuid;
