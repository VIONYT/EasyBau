import type { BillableReport, DocumentDetail } from '@easybau/schemas'
import { useEffect, useId, useState } from 'react'
import { type ApiError, api, apiWithEtag } from '../api'
import { formatDateTime, formatInputNumber } from '../format'
import { FormError } from '../forms'
import { t } from '../i18n'

/**
 * „Berichte übernehmen“ (P2.5) on an invoice draft: signed Regie-/Einsatzberichte of the project
 * become a title with positions; reports that cannot be taken over say why.
 */
export function ReportApplyPanel({
  doc,
  apply,
}: {
  doc: DocumentDetail
  apply: (result: { data: DocumentDetail; etag: string | null }) => void
}) {
  const id = useId()
  const [reports, setReports] = useState<BillableReport[] | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reload whenever the positions change (a removed title makes the report available again).
  const itemCount = doc.items.length
  useEffect(() => {
    if (!open || itemCount < 0) return
    api<BillableReport[]>('GET', `/api/v1/documents/${doc.id}/reports`)
      .then(setReports)
      .catch((err: ApiError) => setError(err.message))
  }, [doc.id, open, itemCount])

  if (!open) {
    return (
      <button type="button" className="button ghost small" onClick={() => setOpen(true)}>
        {t('rep.apply.title')}
      </button>
    )
  }
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      apply(
        await apiWithEtag<DocumentDetail>('POST', `/api/v1/documents/${doc.id}/apply-reports`, {
          reportIds: [...selected],
        }),
      )
      setSelected(new Set())
      setOpen(false)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('rep.apply.title')}</h2>
      <p className="hint">{t('rep.apply.hint')}</p>
      {!reports ? <p className="muted">{t('common.loading')}</p> : null}
      {reports && !reports.length ? <p className="muted">{t('rep.apply.empty')}</p> : null}
      {reports?.length ? (
        <ul className="list plain">
          {reports.map((r) => (
            <li key={r.id}>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={Boolean(r.blocked) || r.inThisDocument}
                  checked={selected.has(r.id) || r.inThisDocument}
                  onChange={(e) => {
                    const next = new Set(selected)
                    if (e.target.checked) next.add(r.id)
                    else next.delete(r.id)
                    setSelected(next)
                  }}
                />
                <span>
                  <strong>
                    {r.template.name} · {formatDateTime(r.reportDate, 'date')}
                  </strong>
                  <span className="muted block">
                    {[
                      Number(r.totalHours)
                        ? `${formatInputNumber(r.totalHours)} ${t('d.hours')}`
                        : '',
                      r.inThisDocument ? t('rep.apply.inThis') : r.blocked,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <FormError>{error}</FormError>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={busy || !selected.size}
          onClick={submit}
        >
          {t('rep.apply.submit')}
        </button>
        <button type="button" className="button ghost auto" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
      </div>
    </section>
  )
}
