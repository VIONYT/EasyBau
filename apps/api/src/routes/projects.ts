import type { Tx } from '@opc/db'
import {
  createProjectRequest,
  type Page,
  type ProjectDetail,
  type ProjectStatus,
  type ProjectSummary,
  projectListQuery,
  type TeamMember,
  type UpdateProjectRequest,
  updateProjectRequest,
} from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requirePermission,
  type Services,
} from '../context.js'
import {
  checkIfMatch,
  decodeCursor,
  encodeCursor,
  etagOf,
  HttpError,
  notFound,
  parse,
} from '../http.js'

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

export const SUMMARY_COLUMNS = (tx: Tx) => tx`
  p.id, p.number, p.name, p.site_city as "siteCity",
  to_char(p.start_date, 'YYYY-MM-DD') as "startDate", to_char(p.end_date, 'YYYY-MM-DD') as "endDate",
  (p.archived_at is not null) as archived,
  to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt",
  case when s.id is null then null else json_build_object('id', s.id, 'label', s.label, 'color', s.color) end as status,
  case when c.id is null then null else json_build_object('id', c.id, 'displayName', c.display_name) end as customer,
  coalesce((select json_agg(json_build_object('id', u.id, 'displayName', u.display_name) order by u.display_name)
            from project_member pm join app_user u on u.id = pm.user_id
            where pm.project_id = p.id), '[]'::json) as members`

const visibility = (tx: Tx, auth: AuthContext) => projectVisibility(tx, auth)

async function loadProject(
  tx: Tx,
  auth: AuthContext,
  id: string,
): Promise<(ProjectDetail & { etag: string }) | null> {
  const [row] = await tx<(ProjectDetail & { updatedRaw: Date })[]>`
    select ${SUMMARY_COLUMNS(tx)}, p.description, p.updated_at as "updatedRaw",
           to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
           json_build_object('street', p.site_street, 'streetExtra', p.site_street_extra,
                             'postalCode', p.site_postal_code, 'city', p.site_city,
                             'countryCode', p.site_country_code) as site
    from project p
    left join project_status s on s.id = p.status_id
    left join contact c on c.id = p.customer_id
    where p.id = ${id} and ${visibility(tx, auth)}`
  if (!row) return null
  const { updatedRaw, ...project } = row
  return { ...project, etag: etagOf(updatedRaw) }
}

function columnsOf(input: UpdateProjectRequest): Record<string, unknown> {
  const columns: Record<string, unknown> = {}
  if (input.name !== undefined) columns.name = input.name
  if (input.description !== undefined) columns.description = input.description
  if (input.statusId !== undefined) columns.status_id = input.statusId
  if (input.customerId !== undefined) columns.customer_id = input.customerId
  if (input.startDate !== undefined) columns.start_date = input.startDate
  if (input.endDate !== undefined) columns.end_date = input.endDate
  if (input.number !== undefined) columns.number = input.number
  if (input.site) {
    columns.site_street = input.site.street ?? null
    columns.site_street_extra = input.site.streetExtra ?? null
    columns.site_postal_code = input.site.postalCode ?? null
    columns.site_city = input.site.city ?? null
    columns.site_country_code = input.site.countryCode
  }
  return columns
}

/** Referenced status, customer and members must exist in the same tenant (RLS hides others). */
async function checkReferences(tx: Tx, input: UpdateProjectRequest) {
  const errors: Record<string, string> = {}
  if (
    input.statusId &&
    !(await tx`select 1 from project_status where id = ${input.statusId}`).length
  ) {
    errors.statusId = 'Unbekannter Status.'
  }
  if (
    input.customerId &&
    !(await tx`select 1 from contact where id = ${input.customerId}`).length
  ) {
    errors.customerId = 'Unbekannter Kunde.'
  }
  if (input.memberIds?.length) {
    const found = await tx`select user_id from membership where user_id in ${tx(input.memberIds)}`
    if (found.length !== new Set(input.memberIds).size)
      errors.memberIds = 'Mindestens eine Person gehört nicht zur Firma.'
  }
  if (Object.keys(errors).length)
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)
}

async function replaceMembers(
  tx: Tx,
  tenantId: string,
  projectId: string,
  memberIds: string[] | undefined,
) {
  if (!memberIds) return
  await tx`delete from project_member where project_id = ${projectId}`
  for (const userId of new Set(memberIds)) {
    await tx`insert into project_member (tenant_id, project_id, user_id) values (${tenantId}, ${projectId}, ${userId})`
  }
}

function uniqueNumberError(error: unknown): never {
  if ((error as { code?: string }).code === '23505') {
    throw new HttpError(409, 'Diese Projektnummer ist bereits vergeben.', {
      number: 'Nummer bereits vergeben.',
    })
  }
  throw error
}

export function registerProjectRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/project-statuses', async (request): Promise<ProjectStatus[]> => {
    const auth = requirePermission(request)
    return inTenant(
      services,
      auth,
      (tx) => tx<ProjectStatus[]>`
      select id, key, label, color, sort, is_closed as "isClosed" from project_status order by sort, label`,
    )
  })

  // Names of the people who can work on projects (team, filter „Mitarbeitende“); no e-mail, no role.
  app.get('/api/v1/team', async (request): Promise<TeamMember[]> => {
    const auth = requirePermission(request)
    return inTenant(
      services,
      auth,
      (tx) => tx<TeamMember[]>`
        select u.id, u.display_name as "displayName"
        from membership m join app_user u on u.id = m.user_id join role r on r.id = m.role_id
        where r.key <> 'auditor' and (m.valid_until is null or m.valid_until >= current_date)
        order by lower(u.display_name), u.id`,
    )
  })

  app.get('/api/v1/projects', async (request): Promise<Page<ProjectSummary>> => {
    const auth = requirePermission(request)
    const query = parse(projectListQuery, request.query)
    const cursor = decodeCursor(query.cursor, 2)
    const search = query.q ? `%${query.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%` : null
    const rows = await inTenant(
      services,
      auth,
      (tx) => tx<(ProjectSummary & { sortKey: string })[]>`
      select ${SUMMARY_COLUMNS(tx)}, to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "sortKey"
      from project p
      left join project_status s on s.id = p.status_id
      left join contact c on c.id = p.customer_id
      where ${visibility(tx, auth)}
        and (p.archived_at is not null) = ${query.archived === 'true'}
        and (${query.statusId ?? null}::uuid is null or p.status_id = ${query.statusId ?? null})
        and (${query.customerId ?? null}::uuid is null or p.customer_id = ${query.customerId ?? null})
        and (${query.memberId ?? null}::uuid is null or exists (
               select 1 from project_member m where m.project_id = p.id and m.user_id = ${query.memberId ?? null}))
        and (${query.from ?? null}::date is null
             or ((p.start_date is not null or p.end_date is not null)
                 and (p.end_date is null or p.end_date >= ${query.from ?? null}::date)))
        and (${query.to ?? null}::date is null
             or ((p.start_date is not null or p.end_date is not null)
                 and (p.start_date is null or p.start_date <= ${query.to ?? null}::date)))
        and (${search}::text is null
             or lower(p.name) like ${search}
             or lower(coalesce(p.number, '')) like ${search}
             or lower(concat_ws(' ', p.site_street, p.site_postal_code, p.site_city)) like ${search}
             or lower(coalesce(c.display_name, '')) like ${search})
        and (${cursor ? String(cursor[0]) : null}::text is null
             or (p.updated_at, p.id) < (${cursor ? String(cursor[0]) : '2000-01-01T00:00:00'}::timestamp at time zone 'UTC',
                                         ${cursor ? String(cursor[1]) : '00000000-0000-0000-0000-000000000000'}::uuid))
      order by p.updated_at desc, p.id desc
      limit ${query.limit + 1}`,
    )
    const more = rows.length > query.limit
    const items = rows.slice(0, query.limit)
    const last = items.at(-1)
    return {
      items: items.map(({ sortKey: _, ...item }) => item),
      nextCursor: more && last ? encodeCursor([last.sortKey, last.id]) : null,
    }
  })

  app.post('/api/v1/projects', async (request, reply) => {
    const auth = requirePermission(request, 'project.write')
    const input = parse(createProjectRequest, request.body)
    const project = await inTenant(services, auth, async (tx) => {
      await checkReferences(tx, input)
      const [number] = input.number
        ? [{ n: input.number }]
        : await tx<{ n: string }[]>`select next_number('project') as n`
      const statusId =
        input.statusId === undefined
          ? ((await tx<{ id: string }[]>`select id from project_status order by sort limit 1`)[0]
              ?.id ?? null)
          : input.statusId
      const columns = {
        ...columnsOf(input),
        status_id: statusId,
        number: number?.n ?? null,
        tenant_id: auth.tenantId,
        created_by: auth.userId,
      }
      const [row] = await tx<
        { id: string }[]
      >`insert into project ${tx(columns)} returning id`.catch(uniqueNumberError)
      const id = (row as { id: string }).id
      // The creator is always a member, so the project stays visible for project leads.
      await replaceMembers(tx, auth.tenantId, id, [...(input.memberIds ?? []), auth.userId])
      // Ablage: folder structure from the company template (Einstellungen › Ablage).
      await tx`insert into project_folder (tenant_id, project_id, name, sort, created_by)
               select tenant_id, ${id}, name, sort, ${auth.userId} from filing_template`
      return loadProject(tx, auth, id)
    })
    const { etag, ...body } = project as ProjectDetail & { etag: string }
    return reply
      .status(201)
      .header('etag', etag)
      .header('location', `/api/v1/projects/${body.id}`)
      .send(body)
  })

  app.get('/api/v1/projects/:id', async (request, reply) => {
    const auth = requirePermission(request)
    const { id } = parse(idParam, request.params)
    const project = await inTenant(services, auth, (tx) => loadProject(tx, auth, id))
    if (!project) throw notFound('Das Projekt')
    const { etag, ...body } = project
    return reply.header('etag', etag).send(body)
  })

  app.patch('/api/v1/projects/:id', async (request, reply) => {
    const auth = requirePermission(request, 'project.write')
    const { id } = parse(idParam, request.params)
    const input = parse(updateProjectRequest, request.body)
    const project = await inTenant(services, auth, async (tx) => {
      const [current] = await tx<
        { updatedAt: Date; startDate: string | null; endDate: string | null }[]
      >`
        select p.updated_at as "updatedAt", to_char(p.start_date, 'YYYY-MM-DD') as "startDate",
               to_char(p.end_date, 'YYYY-MM-DD') as "endDate"
        from project p where p.id = ${id} and ${visibility(tx, auth)} for update`
      if (!current) throw notFound('Das Projekt')
      checkIfMatch(request.headers['if-match'], current.updatedAt)
      const start = input.startDate === undefined ? current.startDate : input.startDate
      const end = input.endDate === undefined ? current.endDate : input.endDate
      if (start && end && end < start) {
        throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
          endDate: 'Das Ende darf nicht vor dem Beginn liegen.',
        })
      }
      await checkReferences(tx, input)
      const columns = columnsOf(input)
      if (Object.keys(columns).length)
        await tx`update project set ${tx(columns)} where id = ${id}`.catch(uniqueNumberError)
      else await tx`update project set updated_at = now() where id = ${id}`
      await replaceMembers(tx, auth.tenantId, id, input.memberIds)
      return loadProject(tx, auth, id)
    })
    const { etag, ...body } = project as ProjectDetail & { etag: string }
    return reply.header('etag', etag).send(body)
  })

  for (const [action, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const) {
    app.post(`/api/v1/projects/:id/${action}`, async (request, reply) => {
      const auth = requirePermission(request, 'project.archive')
      const { id } = parse(idParam, request.params)
      const updated = await inTenant(
        services,
        auth,
        (tx) => tx`
        update project p set archived_at = ${archived ? tx`now()` : null}
        where p.id = ${id} and ${visibility(tx, auth)}`,
      )
      if (!updated.count) throw notFound('Das Projekt')
      return reply.status(204).send()
    })
  }
}
