import type {
  Me,
  ProjectDetail,
  ReportDetail,
  ReportSummary,
  ReportTemplateSummary,
} from '@easybau/schemas'
import { useEffect, useState } from 'react'
import { type ApiError, api, mutate } from '../api'
import { formatDateTime, formatInputNumber } from '../format'
import { Field, FormError, useForm, value } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import type { Navigate } from '../router'

export function weatherText(weather: ReportSummary['weather']): string {
  if (!weather) return ''
  const temps = [weather.temperatureMin, weather.temperatureMax]
    .filter((v): v is string => v !== null)
    .map((v) => `${formatInputNumber(v)} °C`)
    .join(' – ')
  return [weather.condition ? t(`d.weather.${weather.condition}` as TextKey) : '', temps]
    .filter(Boolean)
    .join(', ')
}

const DIARY = 'daily_site_report'

/** Bautagebuch of a project: one daily report (Bautagesbericht) per day, newest first. */
export function ProjectDiary(props: {
  me: Me
  projectId: string
  archived: boolean
  navigate: Navigate
}) {
  return <ProjectReports {...props} kind="diary" />
}

/**
 * Reports of a project: the Bautagebuch, or all other templates (Regie-, Einsatzbericht,
 * Abnahmeprotokoll, Bedenken- und Behinderungsanzeige …) with the template chosen when creating.
 */
export function ProjectReports({
  me,
  projectId,
  archived,
  navigate,
  kind,
}: {
  me: Me
  projectId: string
  archived: boolean
  navigate: Navigate
  kind: 'diary' | 'reports'
}) {
  const diary = kind === 'diary'
  const [reports, setReports] = useState<ReportSummary[] | null>(null)
  const [templates, setTemplates] = useState<ReportTemplateSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const canWrite = me.permissions.includes('report.write') && !archived
  const listPath = `/api/v1/projects/${projectId}/reports${diary ? `?template=${DIARY}` : ''}`

  useEffect(() => {
    api<ReportSummary[]>('GET', listPath)
      .then((list) => setReports(diary ? list : list.filter((r) => r.template.key !== DIARY)))
      .catch((err: ApiError) => setError(err.message))
    if (!diary) {
      api<ReportTemplateSummary[]>('GET', '/api/v1/report-templates')
        .then((list) => setTemplates(list.filter((tpl) => tpl.key !== DIARY)))
        .catch(() => undefined)
    }
  }, [listPath, diary])

  const open = (id: string) => navigate({ view: 'report', id })
  const form = useForm(
    async (data) => {
      // The id is made on the device, so the report can be written offline and synced later.
      const id = crypto.randomUUID()
      const reportDate = value(data, 'reportDate')
      const templateKey = diary ? DIARY : value(data, 'templateKey')
      const [all, project] = await Promise.all([
        api<ReportTemplateSummary[]>('GET', '/api/v1/report-templates'),
        api<ProjectDetail>('GET', `/api/v1/projects/${projectId}`),
      ])
      const template = all.find((tpl) => tpl.key === templateKey)
      if (!template) throw new Error(t('off.notCached'))
      const result = await mutate<ReportDetail>({
        method: 'POST',
        path: `/api/v1/projects/${projectId}/reports`,
        json: { id, templateKey, reportDate },
        resource: `/api/v1/reports/${id}`,
        label: `${template.name} ${formatDateTime(reportDate, 'date')}`,
        optimistic: () => ({
          id,
          projectId,
          template,
          reportDate,
          status: 'draft',
          totalHours: '0',
          staffCount: 0,
          photoCount: 0,
          weather: null,
          createdBy: { id: me.user.id, displayName: me.user.displayName },
          updatedAt: new Date().toISOString(),
          project: { id: project.id, number: project.number, name: project.name },
          serviceFrom: null,
          serviceTo: null,
          header: { contractor: me.tenant.name, client: null, placeOfPerformance: null },
          data: {},
          photos: [],
          signatures: [],
          completedAt: null,
          billable: template.billable,
          billedInvoice: null,
        }),
        alsoUpdate: [
          {
            resource: listPath,
            apply: (list) => [
              {
                id,
                projectId,
                template: { key: template.key, name: template.name },
                reportDate,
                status: 'draft',
                totalHours: '0',
                staffCount: 0,
                photoCount: 0,
                weather: null,
                createdBy: { id: me.user.id, displayName: me.user.displayName },
                updatedAt: new Date().toISOString(),
                billable: template.billable,
                billedInvoice: null,
              } satisfies ReportSummary,
              ...(list as ReportSummary[]),
            ],
          },
        ],
      })
      return result.data
    },
    (report) => open(report.id),
  )
  const today = new Date()
  const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)

  return (
    <div>
      <div className="section-head">
        <h2>{t(diary ? 'd.title' : 'rep.title')}</h2>
        {canWrite && !creating ? (
          <button type="button" className="button primary auto" onClick={() => setCreating(true)}>
            {t(diary ? 'd.new' : 'rep.new')}
          </button>
        ) : null}
      </div>
      {creating ? (
        <form className="panel" onSubmit={form.onSubmit} noValidate>
          <FormError>{form.error}</FormError>
          {diary ? null : (
            <div className="field">
              <label htmlFor="report-template">{t('rep.template')}</label>
              <select id="report-template" name="templateKey" defaultValue="daywork_report">
                {templates.map((tpl) => (
                  <option key={tpl.key} value={tpl.key}>
                    {tpl.name}
                  </option>
                ))}
              </select>
              {form.fieldErrors.templateKey ? (
                <p className="field-error">{form.fieldErrors.templateKey}</p>
              ) : null}
            </div>
          )}
          <Field
            label={t('d.date')}
            name="reportDate"
            type="date"
            defaultValue={localToday}
            error={form.fieldErrors.reportDate}
          />
          <div className="button-row">
            <button type="submit" className="button primary auto" disabled={form.busy}>
              {t(diary ? 'd.create' : 'rep.create')}
            </button>
            <button type="button" className="button ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      <FormError>{error}</FormError>
      {!reports ? <p className="muted">{t('common.loading')}</p> : null}
      {reports && !reports.length ? (
        <p className="muted">{t(diary ? 'd.empty' : 'rep.empty')}</p>
      ) : null}
      {reports?.length ? (
        <ul className="list">
          {reports.map((r) => (
            <li key={r.id} className="list-link">
              <a
                href={`/berichte/${r.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  open(r.id)
                }}
              >
                <span className="doc-line">
                  <strong>
                    {diary ? null : `${r.template.name} · `}
                    {new Intl.DateTimeFormat('de-DE', { weekday: 'short' }).format(
                      new Date(`${r.reportDate}T12:00:00`),
                    )}
                    , {formatDateTime(r.reportDate, 'date')}
                  </strong>
                  <span className={`chip chip--${r.status === 'signed' ? 'accepted' : 'draft'}`}>
                    {t(`d.status.${r.status}` as TextKey)}
                  </span>
                  {r.billedInvoice ? (
                    <span className="chip chip--pay-paid">
                      {tf('rep.billed', { number: r.billedInvoice.number ?? '' })}
                    </span>
                  ) : r.billable && r.status === 'signed' && !diary ? (
                    <span className="chip chip--pay-open">{t('rep.unbilled')}</span>
                  ) : null}
                </span>
                <span className="muted">
                  {[
                    weatherText(r.weather),
                    r.staffCount
                      ? `${r.staffCount} ${r.staffCount === 1 ? t('d.person') : t('d.people')}`
                      : '',
                    r.staffCount ? `${formatInputNumber(r.totalHours)} ${t('d.hours')}` : '',
                    r.photoCount
                      ? `${r.photoCount} ${r.photoCount === 1 ? t('d.photo') : t('d.photos')}`
                      : '',
                    r.createdBy?.displayName,
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
