import type { Tx } from '@opc/db'
import {
  type AuditChainCheck,
  type AuditChainStatus,
  type AuditEventItem,
  type AuditEventList,
  auditEventQuery,
} from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { inTenant, requirePermission, type Services } from '../context.js'
import { decodeCursor, encodeCursor, parse } from '../http.js'
import { rateLimit } from './auth-common.js'

/** Hours after which the Betriebs-Check warns that the nightly check did not run. */
export const AUDIT_CHECK_STALE_HOURS = 26

/** Technical columns that say nothing to a reader; secrets are masked. */
const HIDDEN = new Set(['tenant_id', 'updated_at'])
const SECRET = /(_enc|_hash|secret)$/

function changesOf(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditEventItem['changes'] {
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  const mask = (field: string, value: unknown) =>
    value !== null && value !== undefined && SECRET.test(field) ? '••••' : (value ?? null)
  return fields
    .filter((field) => !HIDDEN.has(field))
    .filter(
      (field) =>
        !before || !after || JSON.stringify(before[field]) !== JSON.stringify(after[field]),
    )
    .sort()
    .map((field) => ({
      field,
      before: before ? mask(field, before[field]) : null,
      after: after ? mask(field, after[field]) : null,
    }))
}

interface CheckRow {
  checkedAt: string
  origin: AuditChainCheck['origin']
  checkedBy: string | null
  events: string
  problem: AuditChainCheck['problem']
  brokenSeq: string | null
}

const toCheck = (r: CheckRow): AuditChainCheck => ({
  checkedAt: r.checkedAt,
  origin: r.origin,
  checkedBy: r.checkedBy,
  events: Number(r.events),
  problem: r.problem,
  brokenSeq: r.brokenSeq === null ? null : Number(r.brokenSeq),
})

/** Newest checks of the company's audit chain. */
export async function auditChainStatus(tx: Tx): Promise<AuditChainStatus> {
  const rows = await tx<CheckRow[]>`
    select to_char(c.checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "checkedAt",
           c.origin, u.display_name as "checkedBy", c.events::text, c.problem,
           c.broken_seq::text as "brokenSeq"
    from audit_chain_check c left join app_user u on u.id = c.checked_by
    order by c.checked_at desc limit 10`
  const recent = rows.map(toCheck)
  // Database time, like checked_at.
  const [fresh] = await tx<{ fresh: boolean }[]>`
    select exists (select 1 from audit_chain_check
                   where checked_at > now() - make_interval(hours => ${AUDIT_CHECK_STALE_HOURS})) as fresh`
  return { last: recent[0] ?? null, recent, stale: !fresh?.fresh }
}

export function registerAuditRoutes(app: FastifyInstance, services: Services) {
  // Änderungsprotokoll: newest first, filter by entity, record and period (Europe/Berlin days).
  app.get('/api/v1/audit/events', async (request): Promise<AuditEventList> => {
    const auth = requirePermission(request, 'audit.read')
    const query = parse(auditEventQuery, request.query)
    const cursor = decodeCursor(query.cursor, 1)
    return inTenant(services, auth, async (tx) => {
      const rows = await tx<
        {
          seq: string
          createdAt: string
          actor: string | null
          action: string
          entity: string
          entityId: string | null
          before: Record<string, unknown> | null
          after: Record<string, unknown> | null
          redactedAt: string | null
        }[]
      >`
        select e.seq::text, to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
               u.display_name as actor, e.action, e.entity, e.entity_id as "entityId", e.before, e.after,
               to_char(e.redacted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "redactedAt"
        from audit_event e left join app_user u on u.id = e.actor_user_id
        where true
          ${query.entity ? tx`and e.entity = ${query.entity}` : tx``}
          ${query.entityId ? tx`and e.entity_id = ${query.entityId}` : tx``}
          ${query.from ? tx`and e.created_at >= (${query.from}::date::timestamp at time zone 'Europe/Berlin')` : tx``}
          ${query.to ? tx`and e.created_at < ((${query.to}::date + 1)::timestamp at time zone 'Europe/Berlin')` : tx``}
          ${cursor ? tx`and e.seq < ${String(cursor[0])}::bigint` : tx``}
        order by e.seq desc
        limit ${query.limit + 1}`
      const page = rows.slice(0, query.limit)
      const lastRow = page.at(-1)
      return {
        items: page.map((r) => ({
          seq: Number(r.seq),
          createdAt: r.createdAt,
          actor: r.actor,
          action: r.action,
          entity: r.entity,
          entityId: r.entityId,
          changes: changesOf(r.before, r.after),
          redactedAt: r.redactedAt,
        })),
        nextCursor: rows.length > query.limit && lastRow ? encodeCursor([lastRow.seq]) : null,
      }
    })
  })

  app.get('/api/v1/audit/chain', async (request): Promise<AuditChainStatus> => {
    const auth = requirePermission(request, 'audit.read')
    return inTenant(services, auth, (tx) => auditChainStatus(tx))
  })

  // Check now (besides the nightly run); limited, as it reads the whole chain.
  app.post('/api/v1/audit/chain/check', async (request, reply) => {
    const auth = requirePermission(request, 'audit.read')
    await rateLimit(services, `audit-check:${auth.tenantId}`, 10)
    const status = await inTenant(services, auth, async (tx) => {
      await tx`select check_audit_chain(current_tenant_id(), 'manual', ${auth.userId})`
      return auditChainStatus(tx)
    })
    return reply.status(201).send(status)
  })
}
