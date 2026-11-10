-- 0017 Rechnungen festschreiben: lineage of positions, legal notes, checks for deductions.

-- Legal notes (§ 13b, Skonto/Fälligkeit, Aufbewahrungshinweis …) are frozen with the invoice,
-- like the snapshots (rule 4), so a reprint in ten years shows the same text.
ALTER TABLE document ADD COLUMN IF NOT EXISTS legal_notes jsonb;

-- Origin of a position: positions are copied Angebot → Auftrag → Rechnung → nächste Rechnung
-- (source_item_id). The root identifies "the same" LV position across all these documents; the
-- Leistungsaufmaß and the quantities billed so far are summed per root.
CREATE OR REPLACE FUNCTION document_item_root(p_item uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up AS (
    SELECT id, source_item_id, 0 AS depth FROM document_item WHERE id = p_item
    UNION ALL
    SELECT i.id, i.source_item_id, up.depth + 1
    FROM document_item i JOIN up ON i.id = up.source_item_id
    WHERE up.depth < 100
  )
  SELECT id FROM up ORDER BY depth DESC LIMIT 1
$$;

-- Deductions of a final / cumulative progress invoice: only finalized, not cancelled progress or
-- partial invoices of the same project (§ 14 Abs. 5 UStG).
CREATE OR REPLACE FUNCTION document_deduction_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner document;
  target document;
BEGIN
  SELECT * INTO owner FROM document WHERE id = NEW.document_id;
  SELECT * INTO target FROM document WHERE id = NEW.deducted_document_id;
  IF target.project_id IS DISTINCT FROM owner.project_id THEN
    RAISE EXCEPTION 'deducted invoice must belong to the same project' USING ERRCODE = 'P0001';
  END IF;
  -- A cancellation repeats the deductions of the cancelled invoice with negated amounts.
  IF owner.invoice_kind <> 'cancellation' AND (
       target.type <> 'invoice' OR target.finalized_at IS NULL OR target.status = 'cancelled'
       OR target.invoice_kind NOT IN ('progress', 'partial')) THEN
    RAISE EXCEPTION 'only finalized progress or partial invoices can be deducted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_document_deduction_guard BEFORE INSERT OR UPDATE ON document_deduction
  FOR EACH ROW EXECUTE FUNCTION document_deduction_guard();

-- A progress or partial invoice that a finalized invoice deducts can no longer be cancelled on
-- its own: the final invoice relies on it (cancel the final invoice first).
CREATE OR REPLACE FUNCTION document_deducted_cancel_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cancels_document_id IS NOT NULL AND (TG_OP = 'INSERT'
       OR NEW.cancels_document_id IS DISTINCT FROM OLD.cancels_document_id) THEN
    IF EXISTS (
      SELECT 1 FROM document_deduction dd JOIN document d ON d.id = dd.document_id
      WHERE dd.deducted_document_id = NEW.cancels_document_id
        AND d.finalized_at IS NOT NULL AND d.status <> 'cancelled'
        AND d.invoice_kind <> 'cancellation'
    ) THEN
      RAISE EXCEPTION 'invoice is deducted by a later invoice; cancel that one first'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_document_deducted_cancel_guard BEFORE INSERT OR UPDATE ON document
  FOR EACH ROW EXECUTE FUNCTION document_deducted_cancel_guard();
