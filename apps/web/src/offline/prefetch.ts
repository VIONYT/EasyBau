import type { MeasurementSheetSummary, ReportSummary } from '@easybau/schemas'
import { api } from '../api'

/**
 * „Offline verfügbar machen“: loads everything the site screens of a project need into the
 * device's cache (ADR 0010) – while there is still network, e.g. in the office or the car park.
 * Returns the number of stored views.
 */
export async function prepareProjectOffline(projectId: string): Promise<number> {
  const base = `/api/v1/projects/${projectId}`
  // All reports of the project (Bautagebuch and the other templates; one list, filtered on screen).
  const reportsPath = `${base}/reports`
  const [sheets, reports] = await Promise.all([
    api<MeasurementSheetSummary[]>('GET', `${base}/measurement-sheets`),
    api<ReportSummary[]>('GET', reportsPath),
    api('GET', '/api/v1/auth/me'),
    api('GET', '/api/v1/projects?q='),
    api('GET', base),
    api('GET', `${base}/folders`),
    api('GET', '/api/v1/units'),
    api('GET', '/api/v1/report-templates'),
    api('GET', `${base}/reports?template=daily_site_report`),
  ])
  const kinds = [...new Set(sheets.map((s) => s.kind))]
  const recent = reports.slice(0, 30)
  await Promise.all([
    ...sheets.map((s) => api('GET', `/api/v1/measurement-sheets/${s.id}`)),
    ...kinds.map((kind) => api('GET', `${base}/measurable-items?kind=${kind}`)),
    ...recent.map((r) => api('GET', `/api/v1/reports/${r.id}`)),
  ])
  return 9 + sheets.length + kinds.length + recent.length
}
