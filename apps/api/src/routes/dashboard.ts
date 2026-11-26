import type { Tx } from '@easybau/db'
import {
  type DashboardDto,
  type DashboardSiteDto,
  type DashboardSum,
  invoiceListQuery,
  type ProjectSummary,
  type SearchHit,
  type SearchKind,
  type SearchResult,
  searchQuery,
} from '@easybau/schemas'
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

/**
 * Part of the Übersicht without amounts (Heute auf der Baustelle, zuletzt bearbeitete Projekte):
 * the web app keeps it on the device, so the start page also works on the site without network
 * (ADR 0010: no Finanzdaten offline).
 */
async function siteOverview(tx: Tx, auth: AuthContext, today: string): Promise<DashboardSiteDto> {
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
  return { today, recentProjects, todaysSites }
}

async function dashboard(tx: Tx, auth: AuthContext, today: string): Promise<DashboardDto> {
  const may = (permission: string) => auth.permissions.has(permission)
  const { recentProjects, todaysSites } = await siteOverview(tx, auth, today)
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
          -- Replaced by a newer version (P2.12): only the newest version is open.
          and not exists (select 1 from document v where v.previous_version_id = d.id)
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
  // Rangfolge: exact match, then the term at the start of the text or of a word, then anywhere.
  const escaped = q.replace(/[%_\\]/g, (c) => `\\${c}`)
  const rank = (column: string) => tx`
    case when lower(${tx.unsafe(column)}) = lower(${q}) then 0
         when ${tx.unsafe(column)} ilike ${`${escaped}%`} or ${tx.unsafe(column)} ilike ${`% ${escaped}%`} then 1
         else 2 end`
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
      order by ${rank('p.name')}, p.archived_at is not null, p.updated_at desc limit 8`,
  )
  if (may('contacts.read')) {
    add(
      'contact',
      await tx<Omit<SearchHit, 'kind'>[]>`
        select c.id, c.display_name as label, c.number as detail, null as "projectId"
        from contact c
        where c.display_name ilike ${pattern} or c.number ilike ${pattern}
           or exists (select 1 from contact_channel ch where ch.contact_id = c.id and ch.value ilike ${pattern})
        order by ${rank('c.display_name')}, c.archived_at is not null, lower(c.display_name) limit 8`,
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
      order by ${rank("coalesce(d.number, '')")}, ${rank("coalesce(d.subject, '')")}, d.document_date desc, d.created_at desc limit 8`
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
        order by ${rank('short_text')}, short_text limit 8`,
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
  // Baustelle: Aufmaßblätter, Berichte (auch ihr Inhalt) und Dateien der sichtbaren Projekte.
  add(
    'sheet',
    await tx<Omit<SearchHit, 'kind'>[]>`
      select s.id, s.title as label,
             concat_ws(' · ', p.number, p.name, to_char(s.measured_on, 'DD.MM.YYYY')) as detail,
             p.id as "projectId"
      from measurement_sheet s join project p on p.id = s.project_id
      where ${projectVisibility(tx, auth)} and not s.is_inline and s.title ilike ${pattern}
      order by ${rank('s.title')}, s.measured_on desc limit 8`,
  )
  add(
    'report',
    await tx<Omit<SearchHit, 'kind'>[]>`
      select r.id, concat_ws(' · ', t.name, to_char(r.report_date, 'DD.MM.YYYY')) as label,
             concat_ws(' · ', p.number, p.name) as detail, p.id as "projectId"
      from report r join report_template t on t.id = r.template_id join project p on p.id = r.project_id
      where ${projectVisibility(tx, auth)}
        and (t.name ilike ${pattern} or exists (
              select 1 from jsonb_path_query(r.data, 'strict $.**') v
              where jsonb_typeof(v) = 'string' and v #>> '{}' ilike ${pattern}))
      order by ${rank('t.name')}, r.report_date desc limit 8`,
  )
  add(
    'file',
    await tx<Omit<SearchHit, 'kind'>[]>`
      select f.id, f.filename as label,
             concat_ws(' · ', p.number, p.name, nullif(f.caption, '')) as detail, p.id as "projectId"
      from file f join project p on p.id = f.project_id
      where ${projectVisibility(tx, auth)} and (f.filename ilike ${pattern} or f.caption ilike ${pattern})
      order by ${rank('f.filename')}, f.created_at desc limit 8`,
  )
  return { q, groups }
}

export function registerDashboardRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/dashboard', async (request): Promise<DashboardDto> => {
    const auth = requirePermission(request)
    const today = todayIn(services.now())
    return inTenant(services, auth, (tx) => dashboard(tx, auth, today))
  })

  app.get('/api/v1/dashboard/site', async (request): Promise<DashboardSiteDto> => {
    const auth = requirePermission(request)
    const today = todayIn(services.now())
    return inTenant(services, auth, (tx) => siteOverview(tx, auth, today))
  })

  app.get('/api/v1/search', async (request): Promise<SearchResult> => {
    const auth = requirePermission(request)
    const { q } = parse(searchQuery, request.query)
    return inTenant(services, auth, (tx) => search(tx, auth, q))
  })
}
