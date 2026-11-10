import type { Me, MeasurementSheetDetail, MeasurementSheetSummary } from '@opc/schemas'
import { MEASUREMENT_KINDS } from '@opc/schemas/constants'
import { useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { Field, FormError, optional, useForm } from '../forms'
import { type TextKey, t } from '../i18n'
import type { Navigate } from '../router'

/** Aufmaßblätter of a project (a sheet always belongs to exactly one project). */
export function ProjectMeasurements({
  me,
  projectId,
  archived,
  navigate,
}: {
  me: Me
  projectId: string
  archived: boolean
  navigate: Navigate
}) {
  const [sheets, setSheets] = useState<MeasurementSheetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [kind, setKind] = useState<(typeof MEASUREMENT_KINDS)[number]>('survey')
  const canWrite = me.permissions.includes('measurement.write') && !archived

  useEffect(() => {
    api<MeasurementSheetSummary[]>('GET', `/api/v1/projects/${projectId}/measurement-sheets`)
      .then(setSheets)
      .catch((err: ApiError) => setError(err.message))
  }, [projectId])

  const open = (id: string) => navigate({ view: 'measurement', id })
  const form = useForm(
    (data) =>
      api<MeasurementSheetDetail>('POST', `/api/v1/projects/${projectId}/measurement-sheets`, {
        kind,
        title: optional(data, 'title'),
        measuredOn: optional(data, 'measuredOn'),
      }),
    (sheet) => open(sheet.id),
  )

  return (
    <div>
      <div className="section-head">
        <h2>{t('m.title')}</h2>
        {canWrite && !creating ? (
          <button type="button" className="button primary auto" onClick={() => setCreating(true)}>
            {t('m.new')}
          </button>
        ) : null}
      </div>
      {creating ? (
        <form className="panel" onSubmit={form.onSubmit} noValidate>
          <h2>{t('m.new')}</h2>
          <FormError>{form.error}</FormError>
          <fieldset className="choices">
            <legend>{t('m.kind')}</legend>
            {MEASUREMENT_KINDS.map((k) => (
              <label key={k}>
                <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
                <span>
                  {t(`m.kind.${k}` as TextKey)}
                  <span className="hint block">{t(`m.kind.${k}.hint` as TextKey)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Field label={t('m.sheetTitle')} name="title" error={form.fieldErrors.title} />
          <Field
            label={t('m.date')}
            name="measuredOn"
            type="date"
            defaultValue={new Date().toISOString().slice(0, 10)}
            error={form.fieldErrors.measuredOn}
          />
          <div className="button-row">
            <button type="submit" className="button primary auto" disabled={form.busy}>
              {t('m.create')}
            </button>
            <button type="button" className="button ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      <FormError>{error}</FormError>
      {!sheets ? <p className="muted">{t('common.loading')}</p> : null}
      {sheets && !sheets.length ? <p className="muted">{t('m.empty')}</p> : null}
      {sheets?.length ? (
        <ul className="list">
          {sheets.map((s) => (
            <li key={s.id} className="list-link">
              <a
                href={`/aufmass/${s.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  open(s.id)
                }}
              >
                <span className="doc-line">
                  <strong>{s.title}</strong>
                  <span className={`chip chip--${s.status === 'signed' ? 'accepted' : 'draft'}`}>
                    {t(`m.status.${s.status}` as TextKey)}
                  </span>
                </span>
                <span className="muted">
                  {[
                    t(`m.kind.${s.kind}` as TextKey),
                    formatDateTime(s.measuredOn, 'date'),
                    `${s.lineCount} ${t('m.lines')}`,
                    s.createdBy?.displayName,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
