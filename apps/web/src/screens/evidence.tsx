import type {
  DocumentDetail,
  EvidenceKind,
  EvidenceRef,
  FileSummary,
  MeasurementSheetSummary,
  ReportSummary,
} from '@easybau/schemas'
import { useEffect, useId, useState } from 'react'
import { type ApiError, api, apiWithEtag } from '../api'
import { formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t } from '../i18n'
import type { Navigate } from '../router'

interface Candidate extends EvidenceRef {
  label: string
}

/**
 * Nachweise eines Nachtrags (P2.6): Berichte, Aufmaßblätter and files of the project that justify
 * the change order. They can be added while the change order is negotiated.
 */
export function EvidencePanel({
  doc,
  canWrite,
  apply,
  navigate,
}: {
  doc: DocumentDetail
  canWrite: boolean
  apply: (result: { data: DocumentDetail; etag: string | null }) => void
  navigate: Navigate
}) {
  const id = useId()
  const evidence = doc.changeOrderInfo?.evidence ?? []
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editable = canWrite && doc.status !== 'cancelled'

  useEffect(() => {
    if (!adding) return
    const base = `/api/v1/projects/${doc.project.id}`
    Promise.all([
      api<ReportSummary[]>('GET', `${base}/reports`),
      api<MeasurementSheetSummary[]>('GET', `${base}/measurement-sheets`),
      api<FileSummary[]>('GET', `${base}/files`),
    ])
      .then(([reports, sheets, files]) =>
        setCandidates([
          ...reports.map((r) => ({
            kind: 'report' as const,
            id: r.id,
            label: `${r.template.name} ${formatDateTime(r.reportDate, 'date')}`,
          })),
          ...sheets.map((s) => ({
            kind: 'measurement_sheet' as const,
            id: s.id,
            label: `${s.title} ${formatDateTime(s.measuredOn, 'date')}`,
          })),
          ...files.map((f) => ({ kind: 'file' as const, id: f.id, label: f.filename })),
        ]),
      )
      .catch((err: ApiError) => setError(err.message))
  }, [adding, doc.project.id])

  const save = async (next: EvidenceRef[]) => {
    setBusy(true)
    setError(null)
    try {
      apply(
        await apiWithEtag<DocumentDetail>('PUT', `/api/v1/documents/${doc.id}/evidence`, {
          evidence: next,
        }),
      )
      setAdding(false)
      setChoice('')
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  const refs = evidence.map(({ kind, id: refId }) => ({ kind, id: refId }))
  const openRef = (ref: EvidenceRef) => {
    if (ref.kind === 'report') navigate({ view: 'report', id: ref.id })
    else if (ref.kind === 'measurement_sheet') navigate({ view: 'measurement', id: ref.id })
  }
  const href = (ref: EvidenceRef) =>
    ref.kind === 'report'
      ? `/berichte/${ref.id}`
      : ref.kind === 'measurement_sheet'
        ? `/aufmass/${ref.id}`
        : `/api/v1/files/${ref.id}/content`
  const free = (candidates ?? []).filter(
    (c) => !evidence.some((e) => e.kind === c.kind && e.id === c.id),
  )
  const kinds: EvidenceKind[] = ['report', 'measurement_sheet', 'file']

  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('ev.title')}</h2>
      <p className="hint">{t('ev.hint')}</p>
      {evidence.length ? (
        <ul className="list">
          {evidence.map((e) => (
            <li key={`${e.kind}-${e.id}`} className="list-row">
              <span>
                <a
                  href={href(e)}
                  target={e.kind === 'file' ? '_blank' : undefined}
                  rel={e.kind === 'file' ? 'noopener' : undefined}
                  onClick={(event) => {
                    if (e.kind === 'file') return
                    event.preventDefault()
                    openRef(e)
                  }}
                >
                  {e.label}
                </a>
                <span className="muted block">
                  {[
                    t(`ev.kind.${e.kind}` as TextKey),
                    e.date ? formatDateTime(e.date, 'date') : '',
                    e.locked ? t('ev.locked') : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {editable ? (
                <button
                  type="button"
                  className="button ghost small"
                  disabled={busy}
                  onClick={() => save(refs.filter((r) => !(r.kind === e.kind && r.id === e.id)))}
                >
                  {t('ev.remove')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('ev.none')}</p>
      )}
      {editable && !adding ? (
        <button type="button" className="button ghost auto" onClick={() => setAdding(true)}>
          {t('ev.add')}
        </button>
      ) : null}
      {adding ? (
        <div className="field">
          <label htmlFor={`${id}-choice`}>{t('ev.add')}</label>
          <select id={`${id}-choice`} value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">{candidates ? t('ev.choose') : t('common.loading')}</option>
            {kinds.map((kind) => {
              const options = free.filter((c) => c.kind === kind)
              return options.length ? (
                <optgroup key={kind} label={t(`ev.kind.${kind}` as TextKey)}>
                  {options.map((c) => (
                    <option key={c.id} value={`${c.kind}:${c.id}`}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              ) : null
            })}
          </select>
          <div className="button-row">
            <button
              type="button"
              className="button primary auto"
              disabled={busy || !choice}
              onClick={() => {
                const [kind, refId] = choice.split(':') as [EvidenceKind, string]
                save([...refs, { kind, id: refId }])
              }}
            >
              {t('ev.add')}
            </button>
            <button type="button" className="button ghost auto" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      <FormError>{error}</FormError>
    </section>
  )
}
