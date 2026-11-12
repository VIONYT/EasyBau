import type {
  Me,
  ProjectDetail,
  ReportDetail,
  ReportSummary,
  ReportTemplateSummary,
} from '@opc/schemas'
import { useEffect, useState } from 'react'
import { type ApiError, api, mutate } from '../api'
import { formatDateTime, formatInputNumber } from '../format'
import { Field, FormError, useForm, value } from '../forms'
import { type TextKey, t } from '../i18n'
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

/** Bautagebuch of a project: one daily report (Bautagesbericht) per day, newest first. */
export function ProjectDiary({
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
  const [reports, setReports] = useState<ReportSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const canWrite = me.permissions.includes('report.write') && !archived

  useEffect(() => {
    api<ReportSummary[]>('GET', `/api/v1/projects/${projectId}/reports?template=daily_site_report`)
      .then(setReports)
      .catch((err: ApiError) => setError(err.message))
  }, [projectId])

  const open = (id: string) => navigate({ view: 'report', id })
  const listPath = `/api/v1/projects/${projectId}/reports?template=daily_site_report`
  const form = useForm(
    async (data) => {
      // The id is made on the device, so the report can be written offline and synced later.
      const id = crypto.randomUUID()
      const reportDate = value(data, 'reportDate')
      const [templates, project] = await Promise.all([
        api<ReportTemplateSummary[]>('GET', '/api/v1/report-templates'),
        api<ProjectDetail>('GET', `/api/v1/projects/${projectId}`),
      ])
      const template = templates.find((tpl) => tpl.key === 'daily_site_report')
      if (!template) throw new Error(t('off.notCached'))
      const result = await mutate<ReportDetail>({
        method: 'POST',
        path: `/api/v1/projects/${projectId}/reports`,
        json: { id, templateKey: 'daily_site_report', reportDate },
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
        <h2>{t('d.title')}</h2>
        {canWrite && !creating ? (
          <button type="button" className="button primary auto" onClick={() => setCreating(true)}>
            {t('d.new')}
          </button>
        ) : null}
      </div>
      {creating ? (
        <form className="panel" onSubmit={form.onSubmit} noValidate>
          <FormError>{form.error}</FormError>
          <Field
            label={t('d.date')}
            name="reportDate"
            type="date"
            defaultValue={localToday}
            error={form.fieldErrors.reportDate}
          />
          <div className="button-row">
            <button type="submit" className="button primary auto" disabled={form.busy}>
              {t('d.create')}
            </button>
            <button type="button" className="button ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      <FormError>{error}</FormError>
      {!reports ? <p className="muted">{t('common.loading')}</p> : null}
      {reports && !reports.length ? <p className="muted">{t('d.empty')}</p> : null}
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
                    {new Intl.DateTimeFormat('de-DE', { weekday: 'short' }).format(
                      new Date(`${r.reportDate}T12:00:00`),
                    )}
                    , {formatDateTime(r.reportDate, 'date')}
                  </strong>
                  <span className={`chip chip--${r.status === 'signed' ? 'accepted' : 'draft'}`}>
                    {t(`d.status.${r.status}` as TextKey)}
                  </span>
                </span>
                <span className="muted">
                  {[
                    weatherText(r.weather),
                    `${r.staffCount} ${r.staffCount === 1 ? t('d.person') : t('d.people')}`,
                    `${formatInputNumber(r.totalHours)} ${t('d.hours')}`,
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
