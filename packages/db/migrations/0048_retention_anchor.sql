-- 0048 Retention starts at the actual issue, not only at the editable document date (security
-- audit run-1): a draft can be back-dated freely, so a document dated 2014 but finalized today was
-- "due" for anonymisation at once. The period now counts from the later of document_date and the
-- day of finalisation (Europe/Berlin). Artifacts stored from now on use the same anchor
-- (apps/api/src/artifacts.ts); locks already written stay as they are and only count as a minimum.

CREATE OR REPLACE FUNCTION document_retention_end(p_document uuid)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT greatest(
    make_date(extract(year FROM greatest(d.document_date,
                                         (d.finalized_at AT TIME ZONE 'Europe/Berlin')::date))::int
              + CASE WHEN d.type IN ('invoice', 'credit_note') THEN t.retention_years ELSE 6 END, 12, 31),
    (SELECT max(a.locked_until) FROM document_artifact a WHERE a.document_id = d.id),
    (SELECT make_date(extract(year FROM max(n.notice_date))::int + 6, 12, 31)
       FROM dunning_notice n WHERE n.invoice_id = d.id),
    (SELECT make_date(extract(year FROM max(p.paid_on))::int + t.retention_years, 12, 31)
       FROM payment p WHERE p.invoice_id = d.id),
    (SELECT make_date(extract(year FROM max(r.created_at))::int + t.retention_years, 12, 31)
       FROM receivable_adjustment r WHERE r.invoice_id = d.id)
  )
  FROM document d JOIN tenant t ON t.id = d.tenant_id
  WHERE d.id = p_document AND d.finalized_at IS NOT NULL
$$;
