-- 0011 Quotes: validity (Bindefrist) and the workflow after completion (sent → accepted/rejected).

ALTER TABLE document ADD COLUMN valid_until date;
ALTER TABLE document ADD CONSTRAINT document_valid_until_check
  CHECK (valid_until IS NULL OR valid_until >= document_date);

-- Change order lines keep their own calculation like quote items; nothing else changes here.
-- A change order's number is derived from its contract (e.g. AB-00101/N01) at completion,
-- so the unique index on (tenant_id, type, number) keeps it unique per company.
COMMENT ON COLUMN item_calc_component.unit_cost_cents IS
  'Cost per unit of the line; for labor in a time unit (min, Std) the hourly rate (Stundensatz)';
