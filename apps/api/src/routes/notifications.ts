import type { Tx } from '@easybau/db'
import { formatCents } from '@easybau/domain'
import { germanDate } from '@easybau/exports'
import { invoiceListQuery, type NotificationKind, type NotificationList } from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { notFound, parse } from '../http.js'
import { hitRateLimit } from '../security/sessions.js'
import { todayIn } from './receivable-state.js'
import { listInvoices } from './receivables.js'

/**
 * Benachrichtigungen (P2.8): per person, written in the same transaction as the event
 * (Bericht unterschrieben, Nachtrag entschieden). „Rechnung überfällig“ is created when the
 * person with the right to dun opens the list, from the invoice list (`receivableState`) – at
 * most once an hour per person and day, not on every poll (the app asks every 5 minutes).
 */

/** The invoice list is evaluated for overdue invoices at most this often per person. */
const OVERDUE_REFRESH_SECONDS = 3600

const idParam = z.object({ id: z.uuid('Ungültige ID.') })
const ISO = (tx: Tx, column: string) =>
  tx.unsafe(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)

export interface NewNotification {
  kind: NotificationKind
  refId: string
  title: string
  body?: string | null
  route: string
}

/** Inserts one notification per person; repeated events for the same object are ignored. */
export async function notify(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
  n: NewNotification,
): Promise<void> {
  const users = [...new Set(userIds)]
  if (!users.length) return
  await tx`
    insert into notification (tenant_id, user_id, kind, ref_id, title, body, route)
    select ${tenantId}, u, ${n.kind}, ${n.refId}, ${n.title}, ${n.body ?? null}, ${n.route}
    from unnest(${users}::uuid[]) as u
    on conflict (tenant_id, user_id, kind, ref_id) do nothing`
}

/** Members of a project except the person who caused the event. */
export async function projectMembersExcept(
  tx: Tx,
  projectId: string,
  userId: string,
): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    select user_id as id from project_member where project_id = ${projectId} and user_id <> ${userId}`
  return rows.map((r) => r.id)
}

/** Overdue invoices (status overdue) become a notification for people who may dun. */
async function refreshOverdue(tx: Tx, auth: AuthContext, today: string): Promise<void> {
  if (!auth.permissions.has('dunning.write') || !auth.permissions.has('document.read')) return
  const { items } = await listInvoices(
    tx,
    auth,
    parse(invoiceListQuery, { status: 'overdue' }),
    today,
  )
  for (const invoice of items.filter((i) => i.type === 'invoice')) {
    await notify(tx, auth.tenantId, [auth.userId], {
      kind: 'invoice_overdue',
      refId: invoice.id,
      title: `Rechnung ${invoice.number} ist überfällig`,
      body: [
        invoice.recipient,
        `offen ${formatCents(BigInt(invoice.openCents))}`,
        invoice.dueDate ? `fällig seit ${germanDate(invoice.dueDate)}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      route: `/dokumente/${invoice.id}`,
    })
  }
}

async function list(tx: Tx, auth: AuthContext): Promise<NotificationList> {
  const items = await tx<NotificationList['items']>`
    select id, kind, title, body, route, ${ISO(tx, 'created_at')} as "createdAt", read_at is not null as read
    from notification where user_id = ${auth.userId}
    order by created_at desc, id desc limit 50`
  const [count] = await tx<{ n: number }[]>`
    select count(*)::int as n from notification where user_id = ${auth.userId} and read_at is null`
  return { unreadCount: count?.n ?? 0, items }
}

export function registerNotificationRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/notifications', async (request): Promise<NotificationList> => {
    const auth = requirePermission(request)
    const today = todayIn(services.now())
    // A new key every day, so an invoice that became overdue overnight shows up in the morning.
    const due = await hitRateLimit(
      services.sql,
      `overdue:${auth.tenantId}:${auth.userId}:${today}`,
      1,
      OVERDUE_REFRESH_SECONDS,
    )
    return inTenant(services, auth, async (tx) => {
      if (due.allowed) await refreshOverdue(tx, auth, today)
      return list(tx, auth)
    })
  })

  app.post('/api/v1/notifications/:id/read', async (request): Promise<NotificationList> => {
    const auth = requirePermission(request)
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, async (tx) => {
      const updated = await tx`
        update notification set read_at = coalesce(read_at, now())
        where id = ${id} and user_id = ${auth.userId}`
      if (!updated.count) throw notFound('Die Benachrichtigung')
      return list(tx, auth)
    })
  })

  app.post('/api/v1/notifications/read-all', async (request): Promise<NotificationList> => {
    const auth = requirePermission(request)
    return inTenant(services, auth, async (tx) => {
      await tx`update notification set read_at = now() where user_id = ${auth.userId} and read_at is null`
      return list(tx, auth)
    })
  })
}
