import type { Tx } from '@easybau/db'
import { dayworkDeadline } from '@easybau/domain'
import {
  addReportPhotoRequest,
  createReportRequest,
  type ReportDetail,
  type ReportSection,
  type ReportSummary,
  type ReportTemplateSummary,
  reportListQuery,
  SECTION_VALUE_SCHEMAS,
  type SignerRole,
  type StaffValue,
  SUPPORTED_SECTION_TYPES,
  signReportRequest,
  updateReportRequest,
  uploadReportPhotoQuery,
  type WeatherValue,
} from '@easybau/schemas'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requireAuth,
  requirePermission,
  requireVisibleProject,
  type Services,
} from '../context.js'
import { checkIfMatch, etagOf, HttpError, notFound, parse } from '../http.js'
import { holidayDates } from './document-settings.js'
import { storeUploadedFile } from './files.js'
import { notify, projectMembersExcept } from './notifications.js'
import { todayOf } from './receivable-state.js'
import { ownSignature } from './signatures.js'

const projectParam = z.object({ id: z.uuid('Ungültige ID.') })
const reportParam = z.object({ id: z.uuid('Ungültige ID.') })
const photoParam = z.object({ id: z.uuid('Ungültige ID.'), fileId: z.uuid('Ungültige ID.') })

const ISO = (tx: Tx, column: string) =>
  tx`to_char(${tx.unsafe(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const invalid = (errors: Record<string, string>) =>
  new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)

const SIGNED_MESSAGE =
  'Der Bericht ist unterschrieben und kann nicht mehr geändert werden (Beweisfunktion). Ergänzungen bitte als neuen Bericht.'

const SUPPORTED = new Set<string>(SUPPORTED_SECTION_TYPES)
const isSupported = (sections: ReportSection[]) => sections.every((s) => SUPPORTED.has(s.type))

/** Sum of all staff hours of a report (two decimals, exact: hours are stored as text). */
export function totalHours(sections: ReportSection[], data: Record<string, unknown>): string {
  let hundredths = 0
  for (const section of sections.filter((s) => s.type === 'staff')) {
    for (const row of (data[section.id] as StaffValue | undefined)?.rows ?? []) {
      const [int, frac = ''] = String(row.hours).split('.')
      hundredths += Number(int) * 100 + Number(frac.padEnd(2, '0').slice(0, 2))
    }
  }
  return (hundredths / 100).toFixed(2).replace(/\.?0+$/, '')
}

function staffCount(sections: ReportSection[], data: Record<string, unknown>): number {
  return sections
    .filter((s) => s.type === 'staff')
    .reduce((n, s) => n + ((data[s.id] as StaffValue | undefined)?.rows.length ?? 0), 0)
}

function weatherOf(sections: ReportSection[], data: Record<string, unknown>): WeatherValue | null {
  const section = sections.find((s) => s.type === 'weather')
  return section ? ((data[section.id] as WeatherValue | undefined) ?? null) : null
}

interface ReportRow {
  id: string
  projectId: string
  reportDate: string
  status: ReportSummary['status']
  data: Record<string, unknown>
  templateKey: string
  templateName: string
  templateId: string
  billable: boolean
  sections: ReportSection[]
  templateSnapshot: ReportSection[] | null
  photoCount: number
  createdBy: ReportSummary['createdBy']
  createdById: string | null
  updatedAt: string
  updatedRaw: Date
  billedInvoice: ReportSummary['billedInvoice']
  submittedOn: string | null
  serviceToDate: string | null
}

function reportColumns(tx: Tx) {
  return tx`
    r.id, r.project_id as "projectId", to_char(r.report_date, 'YYYY-MM-DD') as "reportDate", r.status, r.data,
    t.key as "templateKey", t.name as "templateName", t.id as "templateId", t.billable, t.sections,
    r.template_snapshot as "templateSnapshot",
    (select count(*)::int from report_photo ph where ph.report_id = r.id) as "photoCount",
    case when u.id is null then null else json_build_object('id', u.id, 'displayName', u.display_name) end as "createdBy",
    r.created_by as "createdById", ${ISO(tx, 'r.updated_at')} as "updatedAt", r.updated_at as "updatedRaw",
    (select json_build_object('id', b.id, 'number', b.number) from document b
     where b.id = r.billed_in_invoice_id and b.status <> 'cancelled') as "billedInvoice",
    to_char(r.submitted_on, 'YYYY-MM-DD') as "submittedOn",
    to_char(r.service_to, 'YYYY-MM-DD') as "serviceToDate"`
}

const fromReports = (tx: Tx) => tx`
  report r
  join report_template t on t.id = r.template_id
  join project p on p.id = r.project_id
  left join app_user u on u.id = r.created_by`

const DAYWORK = 'daywork_report'

interface DeadlineContext {
  today: string
  holidays: ReadonlySet<string>
}

/** Today and the company holidays around it (deadlines of Stundenlohnzettel). */
async function deadlineContext(tx: Tx): Promise<DeadlineContext> {
  const today = todayOf(tx)
  const year = Number(today.slice(0, 4))
  return { today, holidays: await holidayDates(tx, [year - 1, year, year + 1]) }
}

function toSummary(row: ReportRow, ctx: DeadlineContext): ReportSummary {
  const sections = row.templateSnapshot ?? row.sections
  return {
    id: row.id,
    projectId: row.projectId,
    template: { key: row.templateKey, name: row.templateName },
    reportDate: row.reportDate,
    status: row.status,
    totalHours: totalHours(sections, row.data),
    staffCount: staffCount(sections, row.data),
    photoCount: row.photoCount,
    weather: weatherOf(sections, row.data),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    billable: row.billable,
    submittedOn: row.submittedOn,
    daywork:
      row.templateKey === DAYWORK
        ? dayworkDeadline({
            performedOn: row.serviceToDate ?? row.reportDate,
            submittedOn: row.submittedOn,
            returned: row.status === 'signed',
            today: ctx.today,
            holidays: ctx.holidays,
          })
        : null,
    billedInvoice: row.billedInvoice,
  }
}

export async function loadReport(
  tx: Tx,
  auth: AuthContext,
  id: string,
): Promise<(ReportDetail & { etag: string }) | null> {
  const [row] = await tx<
    (ReportRow & {
      project: ReportDetail['project']
      serviceFrom: string | null
      serviceTo: string | null
      headerSnapshot: ReportDetail['header'] | null
      liveHeader: ReportDetail['header']
      completedAt: string | null
    })[]
  >`
    select ${reportColumns(tx)},
           json_build_object('id', p.id, 'number', p.number, 'name', p.name) as project,
           to_char(r.service_from, 'YYYY-MM-DD') as "serviceFrom", to_char(r.service_to, 'YYYY-MM-DD') as "serviceTo",
           r.header_snapshot as "headerSnapshot", ${ISO(tx, 'r.completed_at')} as "completedAt",
           json_build_object(
             'contractor', (select name from tenant where id = r.tenant_id),
             'client', (select c.display_name from contact c where c.id = p.customer_id),
             'placeOfPerformance', nullif(concat_ws(', ', p.site_street,
                                   nullif(concat_ws(' ', p.site_postal_code, p.site_city), '')), '')
           ) as "liveHeader"
    from ${fromReports(tx)}
    where r.id = ${id} and ${projectVisibility(tx, auth)}`
  if (!row) return null
  const photos = await tx<ReportDetail['photos']>`
    select ph.file_id as "fileId", f.filename, ph.caption, f.is_evidence as "isEvidence"
    from report_photo ph join file f on f.id = ph.file_id
    where ph.report_id = ${id} order by ph.sort, ph.created_at`
  const signatures = await tx<ReportDetail['signatures']>`
    select signer_role as role, signer_name as name, ${ISO(tx, 'signed_at')} as "signedAt",
           image_asset_id as "imageAssetId"
    from report_signature where report_id = ${id} order by signed_at, id`
  const sections = row.templateSnapshot ?? row.sections
  const sheetIds = sections
    .filter((s) => s.type === 'measurement')
    .map((s) => (row.data[s.id] as { sheetId?: string | null } | undefined)?.sheetId)
    .filter((v): v is string => Boolean(v))
  const linkedSheets = sheetIds.length
    ? await tx<ReportDetail['linkedSheets']>`
        select id, title, to_char(measured_on, 'YYYY-MM-DD') as "measuredOn", status
        from measurement_sheet where id in ${tx(sheetIds)} order by measured_on, title`
    : []
  return {
    ...toSummary(row, await deadlineContext(tx)),
    project: row.project,
    template: {
      id: row.templateId,
      key: row.templateKey,
      name: row.templateName,
      billable: row.billable,
      sections,
    },
    serviceFrom: row.serviceFrom,
    serviceTo: row.serviceTo,
    header: row.headerSnapshot ?? row.liveHeader,
    data: row.data,
    photos,
    signatures,
    linkedSheets,
    completedAt: row.completedAt,
    etag: etagOf(row.updatedRaw),
  }
}

function sendReport(
  reply: FastifyReply,
  report: (ReportDetail & { etag: string }) | null,
  status = 200,
) {
  if (!report) throw notFound('Der Bericht')
  const { etag, ...body } = report
  return reply.status(status).header('etag', etag).send(body)
}

/** Locks an open report for changes; signed reports are evidence and stay unchanged. */
async function lockOpen(tx: Tx, auth: AuthContext, id: string) {
  const [row] = await tx<
    {
      id: string
      status: string
      updatedAt: Date
      projectId: string
      createdBy: string | null
      sections: ReportSection[]
      templateKey: string
    }[]
  >`
    select r.id, r.status, r.updated_at as "updatedAt", r.project_id as "projectId", r.created_by as "createdBy",
           t.sections, t.key as "templateKey"
    from report r join report_template t on t.id = r.template_id join project p on p.id = r.project_id
    where r.id = ${id} and ${projectVisibility(tx, auth)}
    for update of r`
  if (!row) throw notFound('Der Bericht')
  if (row.status !== 'draft') throw new HttpError(409, SIGNED_MESSAGE)
  return row
}

/** Initial values; staff is prefilled from the project team and the company working hours. */
async function initialData(
  tx: Tx,
  projectId: string,
  date: string,
  sections: ReportSection[],
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {}
  for (const section of sections) {
    switch (section.type) {
      case 'weather':
        data[section.id] = {
          condition: null,
          temperatureMin: null,
          temperatureMax: null,
          note: null,
        }
        break
      case 'staff': {
        let rows: StaffValue['rows'] = []
        if (section.transferTimes) {
          rows = await tx<StaffValue['rows']>`
            select u.display_name as name, u.id as "userId", coalesce((
              select trim_scale(round((extract(epoch from (w.end_time - w.start_time)) / 3600
                                       - w.break_minutes / 60.0)::numeric, 2))::text
              from working_hours w
              where w.weekday = extract(isodow from ${date}::date) and w.start_time is not null
                and w.end_time is not null), '0') as hours,
              null as activity
            from project_member pm join app_user u on u.id = pm.user_id
            where pm.project_id = ${projectId}
            order by u.display_name`
        }
        data[section.id] = { rows }
        break
      }
      case 'services':
      case 'materials':
      case 'equipment':
        data[section.id] = { rows: [] }
        break
      case 'text':
        data[section.id] = { text: '' }
        break
      case 'yes_no':
        data[section.id] = { value: null }
        break
      case 'deadline':
        data[section.id] = { date: null }
        break
      case 'checklist':
        data[section.id] = {
          rows: (section.items ?? []).map((label) => ({ label, state: null, note: null })),
        }
        break
      case 'measurement':
        data[section.id] = { sheetId: null, rows: [] }
        break
      default:
        break
    }
  }
  return data
}

/** Validates the given sections against the template and returns the cleaned values. */
async function validateData(
  tx: Tx,
  projectId: string,
  sections: ReportSection[],
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  const unitIds = new Set<string>()
  const sheetIds = new Map<string, string>()
  for (const [key, raw] of Object.entries(input)) {
    const section = sections.find((s) => s.id === key)
    const schema = section ? SECTION_VALUE_SCHEMAS[section.type] : undefined
    if (!section || !schema)
      throw invalid({ [`data.${key}`]: 'Diesen Abschnitt gibt es in der Vorlage nicht.' })
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      const errors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const path = ['data', key, ...issue.path.map(String)].join('.')
        errors[path] ??= issue.message
      }
      throw invalid(errors)
    }
    const value = parsed.data as { rows?: { unitId?: string | null }[]; sheetId?: string | null }
    for (const row of value.rows ?? []) if (row.unitId) unitIds.add(row.unitId)
    if (value.sheetId) sheetIds.set(value.sheetId, key)
    result[key] = parsed.data
  }
  if (unitIds.size) {
    const found = await tx`select id from unit where id in ${tx([...unitIds])} and is_active`
    if (found.length !== unitIds.size) throw invalid({ data: 'Unbekannte Einheit.' })
  }
  // Aufmaßblätter only of the same project (references stay inside a project).
  for (const [sheetId, key] of sheetIds) {
    const [sheet] = await tx`
      select 1 from measurement_sheet where id = ${sheetId} and project_id = ${projectId}`
    if (!sheet)
      throw invalid({ [`data.${key}.sheetId`]: 'Unbekanntes Aufmaßblatt in diesem Projekt.' })
  }
  return result
}

export function registerReportRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/report-templates', async (request): Promise<ReportTemplateSummary[]> => {
    const auth = requireAuth(request)
    const rows = await inTenant(
      services,
      auth,
      (tx) => tx<ReportTemplateSummary[]>`
        select id, key, name, billable, sections from report_template where is_active order by name`,
    )
    // Only templates whose section types this version can fill in.
    return rows.filter((t) => isSupported(t.sections))
  })

  app.get('/api/v1/projects/:id/reports', async (request): Promise<ReportSummary[]> => {
    const auth = requireAuth(request)
    const { id } = parse(projectParam, request.params)
    const { template } = parse(reportListQuery, request.query)
    return inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      const rows = await tx<ReportRow[]>`
        select ${reportColumns(tx)} from ${fromReports(tx)}
        where r.project_id = ${id} and (${template ?? null}::text is null or t.key = ${template ?? null})
        order by r.report_date desc, r.created_at desc
        limit 500`
      const ctx = await deadlineContext(tx)
      return rows.map((row) => toSummary(row, ctx))
    })
  })

  app.post('/api/v1/projects/:id/reports', async (request, reply) => {
    const auth = requirePermission(request, 'report.write')
    const { id } = parse(projectParam, request.params)
    const input = parse(createReportRequest, request.body)
    const result = await inTenant(services, auth, async (tx) => {
      const project = await requireVisibleProject(tx, auth, id)
      // Offline capture sends its own id: the same report again (sync retry) changes nothing.
      if (input.id) {
        const [existing] = await tx<{ projectId: string }[]>`
          select project_id as "projectId" from report where id = ${input.id}`
        if (existing) {
          if (existing.projectId !== id) {
            throw new HttpError(409, 'Diese Berichts-ID gehört zu einem anderen Projekt.')
          }
          return { report: await loadReport(tx, auth, input.id), created: false }
        }
      }
      if (project.archived) {
        throw new HttpError(409, 'Das Projekt ist archiviert. Bitte zuerst wiederherstellen.')
      }
      const [template] = await tx<{ id: string; sections: ReportSection[] }[]>`
        select id, sections from report_template where key = ${input.templateKey} and is_active`
      if (!template || !isSupported(template.sections)) {
        throw invalid({ templateKey: 'Diese Berichtsvorlage gibt es nicht.' })
      }
      const [today] = await tx<{ d: string }[]>`select to_char(current_date, 'YYYY-MM-DD') as d`
      const date = input.reportDate ?? (today as { d: string }).d
      const data = await initialData(tx, id, date, template.sections)
      const [created] = await tx<{ id: string }[]>`
        insert into report (id, tenant_id, project_id, template_id, report_date, data, created_by)
        values (coalesce(${input.id ?? null}::uuid, uuid_v7()), ${auth.tenantId}, ${id}, ${template.id}, ${date},
                ${tx.json(data as never)}, ${auth.userId})
        returning id`.catch((error: { code?: string }) => {
        if (error.code === '23505') {
          throw new HttpError(
            409,
            'Für diesen Tag gibt es schon einen offenen Bericht dieser Art. Bitte diesen ergänzen.',
            { reportDate: 'Bereits ein offener Bericht an diesem Tag.' },
          )
        }
        throw error
      })
      return { report: await loadReport(tx, auth, (created as { id: string }).id), created: true }
    })
    reply.header('location', `/api/v1/reports/${result.report?.id}`)
    return sendReport(reply, result.report, result.created ? 201 : 200)
  })

  app.get('/api/v1/reports/:id', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(reportParam, request.params)
    return sendReport(reply, await inTenant(services, auth, (tx) => loadReport(tx, auth, id)))
  })

  app.patch('/api/v1/reports/:id', async (request, reply) => {
    const auth = requirePermission(request, 'report.write')
    const { id } = parse(reportParam, request.params)
    const input = parse(updateReportRequest, request.body)
    const report = await inTenant(services, auth, async (tx) => {
      const current = await lockOpen(tx, auth, id)
      checkIfMatch(request.headers['if-match'], current.updatedAt)
      const columns: Record<string, unknown> = {}
      if (input.reportDate !== undefined) columns.report_date = input.reportDate
      if (input.serviceFrom !== undefined) columns.service_from = input.serviceFrom
      if (input.serviceTo !== undefined) columns.service_to = input.serviceTo
      if (input.submittedOn !== undefined) {
        if (current.templateKey !== DAYWORK && input.submittedOn !== null)
          throw invalid({ submittedOn: 'Nur Regieberichte (Stundenlohnzettel) werden übergeben.' })
        if (input.submittedOn && input.submittedOn > todayOf(tx))
          throw invalid({ submittedOn: 'Das Übergabedatum darf nicht in der Zukunft liegen.' })
        columns.submitted_on = input.submittedOn
      }
      const from = input.serviceFrom
      const to = input.serviceTo
      if (from && to && to < from)
        throw invalid({ serviceTo: 'Das Ende darf nicht vor dem Beginn liegen.' })
      if (input.data) {
        const values = await validateData(tx, current.projectId, current.sections, input.data)
        await tx`update report set data = data || ${tx.json(values as never)} where id = ${id}`
      }
      if (Object.keys(columns).length) {
        await tx`update report set ${tx(columns)} where id = ${id}`.catch(
          (error: { code?: string }) => {
            if (error.code === '23505') {
              throw invalid({
                reportDate: 'An diesem Tag gibt es schon einen offenen Bericht dieser Art.',
              })
            }
            throw error
          },
        )
      }
      if (!input.data && !Object.keys(columns).length) {
        await tx`update report set updated_at = now() where id = ${id}`
      }
      return loadReport(tx, auth, id)
    })
    return sendReport(reply, report)
  })

  app.delete('/api/v1/reports/:id', async (request, reply) => {
    const auth = requirePermission(request, 'report.write')
    const { id } = parse(reportParam, request.params)
    await inTenant(services, auth, async (tx) => {
      const current = await lockOpen(tx, auth, id)
      if (current.createdBy !== auth.userId && !auth.permissions.has('project.write')) {
        throw new HttpError(
          403,
          'Nur die erstellende Person oder die Projektleitung kann diesen Bericht löschen.',
        )
      }
      await tx`delete from report where id = ${id}`
    })
    return reply.status(204).send()
  })

  // ---- Photos (files of the project's Ablage) ----

  app.post('/api/v1/reports/:id/photos', async (request, reply) => {
    const auth = requirePermission(request, 'report.write')
    const { id } = parse(reportParam, request.params)
    const input = parse(addReportPhotoRequest, request.body)
    const report = await inTenant(services, auth, async (tx) => {
      const current = await lockOpen(tx, auth, id)
      const [file] = await tx<{ mime: string }[]>`
        select mime_type as mime from file where id = ${input.fileId} and project_id = ${current.projectId}`
      if (!file) throw invalid({ fileId: 'Diese Datei gehört nicht zu diesem Projekt.' })
      if (!file.mime.startsWith('image/')) throw invalid({ fileId: 'Bitte ein Foto auswählen.' })
      await tx`
        insert into report_photo (tenant_id, report_id, file_id, caption, sort)
        values (${auth.tenantId}, ${id}, ${input.fileId}, ${input.caption ?? null},
                (select coalesce(max(sort), 0) + 10 from report_photo where report_id = ${id}))
        on conflict (report_id, file_id) do update set caption = excluded.caption`
      await tx`update report set updated_at = now() where id = ${id}`
      return loadReport(tx, auth, id)
    })
    return sendReport(reply, report, 201)
  })

  // Photo straight from the camera (also from the offline outbox): stored in the Ablage (folder
  // „Fotos“ if it exists) and attached to the report in one transaction.
  app.post('/api/v1/reports/:id/photos/upload', async (request, reply) => {
    const auth = requirePermission(request, 'report.write')
    const { id } = parse(reportParam, request.params)
    const query = parse(uploadReportPhotoQuery, request.query)
    const target = await inTenant(services, auth, async (tx) => {
      const current = await lockOpen(tx, auth, id)
      const [folder] = await tx<{ id: string }[]>`
        select id from project_folder where project_id = ${current.projectId} and name = 'Fotos' limit 1`
      return { projectId: current.projectId, folderId: folder?.id ?? null }
    })
    await storeUploadedFile(services, auth, request, target.projectId, {
      filename: query.filename,
      folderId: target.folderId,
      caption: null,
      imageOnly: true,
      onStored: async (tx, fileId) => {
        await lockOpen(tx, auth, id)
        await tx`
          insert into report_photo (tenant_id, report_id, file_id, caption, sort)
          values (${auth.tenantId}, ${id}, ${fileId}, ${query.caption ?? null},
                  (select coalesce(max(sort), 0) + 10 from report_photo where report_id = ${id}))`
        await tx`update report set updated_at = now() where id = ${id}`
      },
    })
    const report = await inTenant(services, auth, (tx) => loadReport(tx, auth, id))
    return sendReport(reply, report, 201)
  })

  app.delete('/api/v1/reports/:id/photos/:fileId', async (request, reply) => {
    const auth = requirePermission(request, 'report.write')
    const { id, fileId } = parse(photoParam, request.params)
    const report = await inTenant(services, auth, async (tx) => {
      await lockOpen(tx, auth, id)
      const deleted =
        await tx`delete from report_photo where report_id = ${id} and file_id = ${fileId}`
      if (!deleted.count) throw notFound('Das Foto')
      await tx`update report set updated_at = now() where id = ${id}`
      return loadReport(tx, auth, id)
    })
    return sendReport(reply, report)
  })

  // ---- Signing: afterwards the report and its photos are evidence (VOB/B § 6) ----

  app.post('/api/v1/reports/:id/sign', async (request, reply) => {
    const auth = requirePermission(request, 'report.sign')
    const { id } = parse(reportParam, request.params)
    const { signatures } = parse(signReportRequest, request.body)
    const report = await inTenant(services, auth, async (tx) => {
      const current = await lockOpen(tx, auth, id)
      const required = new Set<SignerRole>(
        current.sections.filter((s) => s.type === 'signatures').flatMap((s) => s.roles ?? []),
      )
      const given = new Set(signatures.map((s) => s.role))
      const missing = [...required].filter((role) => !given.has(role))
      if (missing.length) {
        throw invalid({
          signatures: `Es fehlt die Unterschrift für: ${missing
            .map(
              (r) =>
                ({ contractor: 'Auftragnehmer', client: 'Auftraggeber', other: 'Weitere Person' })[
                  r
                ],
            )
            .join(', ')}.`,
        })
      }
      for (const [index, signature] of signatures.entries()) {
        const image = await ownSignature(
          tx,
          auth,
          signature.signatureAssetId,
          `signatures.${index}.signatureAssetId`,
        )
        await tx`
          insert into report_signature (tenant_id, report_id, signer_name, signer_role, image_asset_id)
          values (${auth.tenantId}, ${id}, ${signature.name}, ${signature.role}, ${image})`
      }
      const [live] = await tx<{ header: ReportDetail['header'] }[]>`
        select json_build_object(
          'contractor', (select name from tenant where id = r.tenant_id),
          'client', (select c.display_name from contact c where c.id = p.customer_id),
          'placeOfPerformance', nullif(concat_ws(', ', p.site_street,
                                nullif(concat_ws(' ', p.site_postal_code, p.site_city), '')), '')
        ) as header
        from report r join project p on p.id = r.project_id where r.id = ${id}`
      await tx`
        update report set status = 'signed', completed_at = now(),
               header_snapshot = ${tx.json((live?.header ?? null) as never)},
               template_snapshot = ${tx.json(current.sections as never)}
        where id = ${id}`
      // The photos become evidence: they can no longer be deleted or replaced.
      await tx`update file set is_evidence = true
               where id in (select file_id from report_photo where report_id = ${id}) and not is_evidence`
      // Benachrichtigung for the project team (P2.8).
      const [info] = await tx<{ name: string; date: string }[]>`
        select t.name, to_char(r.report_date, 'DD.MM.YYYY') as date
        from report r join report_template t on t.id = r.template_id where r.id = ${id}`
      await notify(
        tx,
        auth.tenantId,
        await projectMembersExcept(tx, current.projectId, auth.userId),
        {
          kind: 'report_signed',
          refId: id,
          title: `${info?.name ?? 'Bericht'} vom ${info?.date ?? ''} unterschrieben`,
          body: `von ${auth.displayName}`,
          route: `/berichte/${id}`,
        },
      )
      return loadReport(tx, auth, id)
    })
    return sendReport(reply, report)
  })
}
