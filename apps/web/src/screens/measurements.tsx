import type { Me, MeasurementSheetDetail, MeasurementSheetSummary } from '@easybau/schemas'
import { MEASUREMENT_KINDS } from '@easybau/schemas/constants'
import { Button } from '@easybau/ui'
import { useEffect, useState } from 'react'
import { type ApiError, api, mutate } from '../api'
import { formatDateTime } from '../format'
import { Field, FormError, optional, useForm } from '../forms'
import { type TextKey, t } from '../i18n'
import type { Navigate } from '../router'

/** Aufmaßblätter of a project (a sheet always belongs to exactly one project). */
export function ProjectMeasurements({
  me,
  project,
  navigate,
}: {
  me: Me
  /** The open project; its number and name go into sheets created offline (back link). */
  project: { id: string; number: string | null; name: string; archived: boolean }
  navigate: Navigate
}) {
  const projectId = project.id
  const archived = project.archived
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
  // New sheets get their id on the device: they can be created offline (outbox, ADR 0010).
  const form = useForm(
    async (data) => {
      const id = crypto.randomUUID()
      const title = optional(data, 'title')
      const measuredOn = optional(data, 'measuredOn') ?? new Date().toISOString().slice(0, 10)
      const now = new Date().toISOString()
      const summary: MeasurementSheetSummary = {
        id,
        projectId,
        kind,
        title: title ?? t(`m.kind.${kind}` as TextKey),
        measuredOn,
        status: 'draft',
        lineCount: 0,
        createdBy: { id: me.user.id, displayName: me.user.displayName },
        updatedAt: now,
      }
      const listPath = `/api/v1/projects/${projectId}/measurement-sheets`
      const result = await mutate<MeasurementSheetDetail>({
        method: 'POST',
        path: listPath,
        json: { id, kind, title, measuredOn },
        resource: `/api/v1/measurement-sheets/${id}`,
        label: `${t('m.new')}: ${summary.title}`,
        optimistic: () => ({
          ...summary,
          project: { id: projectId, number: project.number, name: project.name },
          signedAt: null,
          signedByContractor: null,
          signedByClient: null,
          contractorSignatureAssetId: null,
          clientSignatureAssetId: null,
          locations: [],
          lines: [],
          items: [],
          unassigned: [],
        }),
        alsoUpdate: [
          {
            resource: listPath,
            apply: (current) => [summary, ...((current as MeasurementSheetSummary[]) ?? [])],
          },
        ],
      })
      return result.data
    },
    (sheet) => open(sheet.id),
  )

  return (
    <div>
      <div className="section-head">
        <h2>{t('m.title')}</h2>
        {canWrite && !creating ? (
          <Button type="button" variant="primary" onClick={() => setCreating(true)}>
            {t('m.new')}
          </Button>
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
            <Button type="submit" variant="primary" disabled={form.busy}>
              {t('m.create')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              width="natural"
              onClick={() => setCreating(false)}
            >
              {t('common.cancel')}
            </Button>
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
