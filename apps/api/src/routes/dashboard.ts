import type { Tx } from '@opc/db'
import {
  type DashboardDto,
  type DashboardSum,
  invoiceListQuery,
  type ProjectSummary,
  type SearchHit,
  type SearchKind,
  type SearchResult,
  searchQuery,
} from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requirePermission,
  type Services,
} from '../context.js'
import { parse } from '../http.js'
import { incomingVisibility } from './incoming-invoices.js'
import { SUMMARY_COLUMNS } from './projects.js'
import { listInvoices, todayIn } from './receivables.js'

/**
 * Übersicht und globale Suche (P2.8, DESIGN.md §7.3): each part only with the right to see it;
 * amounts come from the invoice list (`receivableState`), never from own SQL.
 */

async function receivables(tx: Tx, auth: AuthContext, today: string) {
  const { items } = await listInvoices(tx, auth, parse(invoiceListQuery, {}), today)
  const empty = (): DashboardSum => ({ count: 0, cents: 0 })
  const result = {
    open: empty(),
    overdue: empty(),
    dunned: empty(),
    total: empty(),
    dunningDueCount: 0,
  }
  for (const item of items) {
    if (item.nextDunning?.due) result.dunningDueCount += 1
    if (item.type !== 'invoice' || item.openCents <= 0) continue
    const bucket =
      item.status === 'overdue'
        ? result.overdue
        : item.status === 'dunned'
          ? result.dunned
          : item.status === 'open' || item.status === 'partially_paid'
            ? result.open
            : null
    if (!bucket) continue
    bucket.count += 1
    bucket.cents += item.openCents
    result.total.count += 1
    result.total.cents += item.openCents
  }
  return result
}

async function dashboard(tx: Tx, auth: AuthContext, today: string): Promise<DashboardDto> {
  const may = (permission: string) => auth.permissions.has(permission)
  const recentProjects = await tx<ProjectSummary[]>`
    select ${SUMMARY_COLUMNS(tx)}
    from project p
    left join project_status s on s.id = p.status_id
    left join contact c on c.id = p.customer_id
    where p.archived_at is null and ${projectVisibility(tx, auth)}
    order by p.updated_at desc, p.id desc limit 5`
  const todaysSites = await tx<DashboardDto['todaysSites']>`
    select p.id, p.number, p.name,
           nullif(concat_ws(', ', p.site_street, nullif(concat_ws(' ', p.site_postal_code, p.site_city), '')), '') as site,
           to_char(p.end_date, 'YYYY-MM-DD') as "endDate"
    from project p left join project_status s on s.id = p.status_id
    where p.archived_at is null and coalesce(s.is_closed, false) = false
      and exists (select 1 from project_member m where m.project_id = p.id and m.user_id = ${auth.userId})
      and p.start_date <= ${today}::date and (p.end_date is null or p.end_date >= ${today}::date)
    order by p.start_date, p.name limit 10`
  const openOffers = may('document.read')
    ? await tx<NonNullable<DashboardDto['openOffers']>>`
        select d.id, d.type, d.number, d.subject, d.status, to_char(d.document_date, 'YYYY-MM-DD') as "documentDate",
               to_char(d.valid_until, 'YYYY-MM-DD') as "validUntil", d.net_total_cents::float8 as "netCents",
               json_build_object('id', p.id, 'number', p.number, 'name', p.name) as project
        from document d join project p on p.id = d.project_id
        where d.type in ('quote', 'cost_estimate', 'change_order') and d.status in ('finalized', 'sent')
          -- An Angebot with an Auftragsbestätigung is decided, even when its status was not set.
          and not exists (select 1 from document o where o.source_document_id = d.id
                          and o.type = 'order_confirmation' and o.status <> 'cancelled')
          and p.archived_at is null and ${projectVisibility(tx, auth)}
        order by d.document_date desc, d.created_at desc limit 10`
    : null
  const [review] = may('incoming_invoice.read')
    ? await tx<{ n: number }[]>`
        select count(*)::int as n from incoming_invoice i where i.status = 'review' and ${incomingVisibility(tx, auth)}`
    : []
  return {
    today,
    receivables: may('document.read') ? await receivables(tx, auth, today) : null,
    incomingReviewCount: may('incoming_invoice.read') ? (review?.n ?? 0) : null,
    recentProjects,
    openOffers,
    todaysSites,
  }
}

const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`

const DOCUMENT_LABEL: Record<string, string> = {
  quote: 'Angebot',
  cost_estimate: 'Kostenvoranschlag',
  order_confirmation: 'Auftragsbestätigung',
  change_order: 'Nachtrag',
  delivery_note: 'Lieferschein',
  invoice: 'Rechnung',
  credit_note: 'Gutschrift',
}

async function search(tx: Tx, auth: AuthContext, q: string): Promise<SearchResult> {
  const pattern = like(q)
  const may = (permission: string) => auth.permissions.has(permission)
  const groups: SearchResult['groups'] = []
  const add = (kind: SearchKind, hits: Omit<SearchHit, 'kind'>[]) => {
    if (hits.length) groups.push({ kind, hits: hits.map((h) => ({ kind, ...h })) })
  }
  add(
    'project',
    await tx<Omit<SearchHit, 'kind'>[]>`
      select p.id, concat_ws(' · ', p.number, p.name) as label,
             nullif(concat_ws(' · ', c.display_name, p.site_city), '') as detail, p.id as "projectId"
      from project p left join contact c on c.id = p.customer_id
      where ${projectVisibility(tx, auth)}
        and (p.name ilike ${pattern} or p.number ilike ${pattern} or c.display_name ilike ${pattern}
             or concat_ws(' ', p.site_street, p.site_postal_code, p.site_city) ilike ${pattern})
      order by p.archived_at is not null, p.updated_at desc limit 8`,
  )
  if (may('contacts.read')) {
    add(
      'contact',
      await tx<Omit<SearchHit, 'kind'>[]>`
        select c.id, c.display_name as label, c.number as detail, null as "projectId"
        from contact c
        where c.display_name ilike ${pattern} or c.number ilike ${pattern}
           or exists (select 1 from contact_channel ch where ch.contact_id = c.id and ch.value ilike ${pattern})
        order by c.archived_at is not null, lower(c.display_name) limit 8`,
    )
  }
  if (may('document.read')) {
    const docs = await tx<
      (Omit<SearchHit, 'kind' | 'label'> & {
        type: string
        number: string | null
        subject: string | null
      })[]
    >`
      select d.id, d.type, d.number, d.subject, p.id as "projectId",
             concat_ws(' · ', p.number, p.name, coalesce(d.recipient_snapshot ->> 'name', c.display_name)) as detail
      from document d join project p on p.id = d.project_id left join contact c on c.id = d.contact_id
      where ${projectVisibility(tx, auth)}
        and (d.number ilike ${pattern} or d.subject ilike ${pattern}
             or coalesce(d.recipient_snapshot ->> 'name', c.display_name) ilike ${pattern})
      order by d.document_date desc, d.created_at desc limit 8`
    add(
      'document',
      docs.map(({ type, number, subject, ...hit }) => ({
        ...hit,
        label: [DOCUMENT_LABEL[type] ?? type, number ?? 'Entwurf', subject]
          .filter(Boolean)
          .join(' · '),
      })),
    )
  }
  if (may('catalog.read')) {
    add(
      'catalog',
      await tx<Omit<SearchHit, 'kind'>[]>`
        select id, short_text as label, nullif(concat_ws(' · ', article_no, manufacturer), '') as detail,
               null as "projectId"
        from catalog_item
        where archived_at is null and (short_text ilike ${pattern} or article_no ilike ${pattern})
        order by short_text limit 8`,
    )
  }
  if (may('incoming_invoice.read')) {
    add(
      'incoming',
      await tx<Omit<SearchHit, 'kind'>[]>`
        select i.id, concat_ws(' · ', i.supplier_name, i.invoice_number) as label,
               coalesce(i.filename, '') as detail, null as "projectId"
        from incoming_invoice i
        where ${incomingVisibility(tx, auth)}
          and (i.supplier_name ilike ${pattern} or i.invoice_number ilike ${pattern} or i.filename ilike ${pattern})
        order by i.received_at desc limit 8`,
    )
  }
  return { q, groups }
}

export function registerDashboardRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/dashboard', async (request): Promise<DashboardDto> => {
    const auth = requirePermission(request)
    const today = todayIn(services.now())
    return inTenant(services, auth, (tx) => dashboard(tx, auth, today))
  })

  app.get('/api/v1/search', async (request): Promise<SearchResult> => {
    const auth = requirePermission(request)
    const { q } = parse(searchQuery, request.query)
    return inTenant(services, auth, (tx) => search(tx, auth, q))
  })
}
