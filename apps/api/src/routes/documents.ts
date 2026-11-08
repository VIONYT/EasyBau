import type { Tx } from '@opc/db'
import {
  CalculationError,
  calculateDocumentTotals,
  type DocumentLineInput,
  type PositionType,
  priceItem,
  type TaxCategory,
} from '@opc/domain'
import {
  type CreateDocumentRequest,
  createDocumentRequest,
  createItemRequest,
  type DocumentDetail,
  type DocumentItem,
  type DocumentOption,
  type DocumentSummary,
  type DocumentTotals,
  moveItemRequest,
  PRICED_POSITION_TYPES,
  type TaxRateSummary,
  type UnitSummary,
  updateDocumentRequest,
  updateItemRequest,
} from '@opc/schemas'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requirePermission,
  requireVisibleProject,
  type Services,
} from '../context.js'
import { checkIfMatch, etagOf, HttpError, notFound, parse } from '../http.js'

const projectParam = z.object({ id: z.uuid('Ungültige ID.') })
const documentParam = z.object({ id: z.uuid('Ungültige ID.') })
const itemParam = z.object({ id: z.uuid('Ungültige ID.'), itemId: z.uuid('Ungültige ID.') })

const NUMBERED: ReadonlySet<string> = new Set([
  'title',
  'item',
  'alternative',
  'optional',
  'lump_sum',
])
const PRICED: ReadonlySet<string> = new Set(PRICED_POSITION_TYPES)
/** Titles may be nested once (Titel › Untertitel › Positionen). */
const MAX_TITLE_LEVEL = 1

const ISO = (tx: Tx, column: string) =>
  tx`to_char(${tx.unsafe(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const DATE = (tx: Tx, column: string) => tx`to_char(${tx.unsafe(column)}, 'YYYY-MM-DD')`

function summaryColumns(tx: Tx) {
  return tx`
    d.id, d.project_id as "projectId", d.type, d.invoice_kind as "invoiceKind", d.progress_no as "progressNo",
    d.status, d.number, d.subject, ${DATE(tx, 'd.document_date')} as "documentDate",
    d.net_total_cents::float8 as "netTotalCents", d.gross_total_cents::float8 as "grossTotalCents",
    ${ISO(tx, 'd.updated_at')} as "updatedAt",
    case when cu.id is null then null else json_build_object('id', cu.id, 'displayName', cu.display_name) end as "createdBy",
    case when co.document_id is null then null
         else json_build_object('number', co.number, 'basis', co.basis, 'status', co.status) end as "changeOrder"`
}

const fromDocuments = (tx: Tx) => tx`
  document d
  join project p on p.id = d.project_id
  left join app_user cu on cu.id = d.created_by
  left join change_order_meta co on co.document_id = d.id`

// ---- Positions: outline, numbering (OZ), prices ------------------------------------------------

interface ItemRow {
  id: string
  parentId: string | null
  sort: number
  positionType: DocumentItem['positionType']
  oz: string | null
  shortText: string | null
  longText: string | null
  quantity: string | null
  unitId: string | null
  unitSymbol: string | null
  unitPriceCents: string | null
  discountPercent: string | null
  totalCents: string | null
  taxRatePercent: string | null
  taxCategory: TaxCategory | null
}

async function loadItems(tx: Tx, documentId: string): Promise<ItemRow[]> {
  return tx<ItemRow[]>`
    select id, parent_id as "parentId", sort, position_type as "positionType", oz,
           short_text as "shortText", long_text as "longText",
           trim_scale(quantity)::text as quantity, unit_id as "unitId", unit_symbol as "unitSymbol",
           unit_price_cents::text as "unitPriceCents", trim_scale(discount_percent)::text as "discountPercent",
           total_cents::text as "totalCents", trim_scale(tax_rate_percent)::text as "taxRatePercent",
           tax_category as "taxCategory"
    from document_item where document_id = ${documentId}`
}

/** Depth-first order of the outline with level and Ordnungszahl (1, 1.1, 1.1.1 …). */
function outline(rows: ItemRow[]): { row: ItemRow; level: number; oz: string | null }[] {
  const children = new Map<string | null, ItemRow[]>()
  for (const row of rows) {
    const list = children.get(row.parentId) ?? []
    list.push(row)
    children.set(row.parentId, list)
  }
  const result: { row: ItemRow; level: number; oz: string | null }[] = []
  const walk = (parentId: string | null, prefix: string, level: number) => {
    const list = (children.get(parentId) ?? []).sort(
      (a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1),
    )
    let n = 0
    for (const row of list) {
      let oz: string | null = null
      if (NUMBERED.has(row.positionType)) {
        n += 1
        oz = prefix ? `${prefix}.${n}` : String(n)
      }
      result.push({ row, level, oz })
      if (row.positionType === 'title') walk(row.id, oz ?? prefix, level + 1)
    }
  }
  walk(null, '', 0)
  return result
}

function lineTotal(row: ItemRow): bigint | null {
  if (!PRICED.has(row.positionType)) return null
  return priceItem({
    quantity: row.quantity ?? '0',
    unitPriceCents: row.unitPriceCents ?? '0',
    ...(row.discountPercent ? { discountPercent: row.discountPercent } : {}),
  }).totalCents
}

function calculationError(error: unknown): never {
  if (error instanceof CalculationError) throw new HttpError(400, error.message)
  throw error
}

/**
 * Recomputes numbering, line totals, VAT per rate and document totals of a draft and stores them.
 * The server always calculates itself; the client only shows what it gets back (rule 11 analog).
 */
async function recalculate(tx: Tx, documentId: string): Promise<void> {
  const [doc] = await tx<{ taxMode: string; discountPercent: string | null }[]>`
    select tax_mode as "taxMode", discount_percent::text as "discountPercent"
    from document where id = ${documentId}`
  if (!doc) return
  const rows = await loadItems(tx, documentId)
  const lines: DocumentLineInput[] = []
  for (const { row, oz } of outline(rows)) {
    const total = (() => {
      try {
        return lineTotal(row)
      } catch (error) {
        return calculationError(error)
      }
    })()
    const totalText = total === null ? null : total.toString()
    if (oz !== row.oz || totalText !== row.totalCents) {
      await tx`update document_item set oz = ${oz}, total_cents = ${totalText} where id = ${row.id}`
    }
    lines.push({
      id: row.id,
      parentId: row.parentId,
      positionType: row.positionType as PositionType,
      ...(total === null ? {} : { totalCents: total }),
      ...(row.taxRatePercent ? { taxRatePercent: row.taxRatePercent } : {}),
      ...(row.taxCategory ? { taxCategory: row.taxCategory } : {}),
    })
  }
  let totals: ReturnType<typeof calculateDocumentTotals>
  try {
    totals = calculateDocumentTotals({
      lines,
      taxMode: doc.taxMode as 'standard',
      ...(doc.discountPercent ? { discountPercent: doc.discountPercent } : {}),
    })
  } catch (error) {
    calculationError(error)
  }
  await tx`
    update document set net_total_cents = ${totals.netCents.toString()},
                        tax_total_cents = ${totals.taxCents.toString()},
                        gross_total_cents = ${totals.grossCents.toString()},
                        updated_at = now()
    where id = ${documentId}`
  await tx`delete from document_tax_line where document_id = ${documentId}`
  for (const line of totals.taxLines) {
    await tx`
      insert into document_tax_line (tenant_id, document_id, tax_category, rate_percent, net_cents, tax_cents, exemption_reason)
      select tenant_id, id, ${line.category}, ${line.ratePercent}, ${line.netCents.toString()},
             ${line.taxCents.toString()}, ${line.exemptionReason ?? null}
      from document where id = ${documentId}`
  }
}

function totalsOf(
  rows: ItemRow[],
  doc: { taxMode: string; discountPercent: string | null },
): DocumentTotals {
  const totals = calculateDocumentTotals({
    lines: rows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      positionType: row.positionType as PositionType,
      ...(row.totalCents === null ? {} : { totalCents: BigInt(row.totalCents) }),
      ...(row.taxRatePercent ? { taxRatePercent: row.taxRatePercent } : {}),
      ...(row.taxCategory ? { taxCategory: row.taxCategory } : {}),
    })),
    taxMode: doc.taxMode as 'standard',
    ...(doc.discountPercent ? { discountPercent: doc.discountPercent } : {}),
  })
  return {
    itemsNetCents: Number(totals.itemsNetCents),
    discountCents: Number(totals.discountCents),
    netCents: Number(totals.netCents),
    taxCents: Number(totals.taxCents),
    grossCents: Number(totals.grossCents),
    taxLines: totals.taxLines.map((t) => ({
      category: t.category,
      ratePercent: t.ratePercent,
      netCents: Number(t.netCents),
      taxCents: Number(t.taxCents),
      exemptionReason: t.exemptionReason ?? null,
    })),
    titleSubtotals: Object.fromEntries(
      [...totals.titleSubtotals].map(([id, cents]) => [id, Number(cents)]),
    ),
  }
}

// ---- Loading ------------------------------------------------------------------------------------

type DocumentRow = Omit<DocumentDetail, 'items' | 'totals'> & {
  updatedRaw: Date
  finalizedAt: Date | null
}

async function loadDocument(
  tx: Tx,
  auth: AuthContext,
  id: string,
): Promise<(DocumentDetail & { etag: string }) | null> {
  const [row] = await tx<DocumentRow[]>`
    select ${summaryColumns(tx)}, d.updated_at as "updatedRaw", d.finalized_at as "finalizedAt",
           json_build_object('id', p.id, 'number', p.number, 'name', p.name) as project,
           case when c.id is null then null else json_build_object('id', c.id, 'displayName', c.display_name) end as contact,
           d.place_of_performance as "placeOfPerformance",
           ${DATE(tx, 'd.service_from')} as "serviceFrom", ${DATE(tx, 'd.service_to')} as "serviceTo",
           d.intro_text as "introText", d.closing_text as "closingText", d.payment_due_days as "paymentDueDays",
           trim_scale(d.discount_percent)::text as "discountPercent", d.tax_mode as "taxMode",
           d.source_document_id as "sourceDocumentId"
    from ${fromDocuments(tx)}
    left join contact c on c.id = d.contact_id
    where d.id = ${id} and ${projectVisibility(tx, auth)}`
  if (!row) return null
  const rows = await loadItems(tx, id)
  const { updatedRaw, finalizedAt: _, ...doc } = row
  const items: DocumentItem[] = outline(rows).map(({ row: r, level }) => ({
    id: r.id,
    parentId: r.parentId,
    positionType: r.positionType,
    oz: r.oz,
    level,
    shortText: r.shortText,
    longText: r.longText,
    quantity: r.quantity,
    unit: r.unitId ? { id: r.unitId, symbol: r.unitSymbol ?? '' } : null,
    unitPriceCents: r.unitPriceCents === null ? null : Number(r.unitPriceCents),
    discountPercent: r.discountPercent,
    totalCents: r.totalCents === null ? null : Number(r.totalCents),
    taxRatePercent: r.taxRatePercent,
  }))
  return { ...doc, items, totals: totalsOf(rows, doc), etag: etagOf(updatedRaw) }
}

/** Locks a draft for changes; finalized documents are immutable (rule 2). */
async function lockDraft(tx: Tx, auth: AuthContext, id: string) {
  const [row] = await tx<{ id: string; status: string; updatedAt: Date; projectId: string }[]>`
    select d.id, d.status, d.updated_at as "updatedAt", d.project_id as "projectId"
    from document d join project p on p.id = d.project_id
    where d.id = ${id} and ${projectVisibility(tx, auth)}
    for update of d`
  if (!row) throw notFound('Das Dokument')
  if (row.status !== 'draft') {
    throw new HttpError(
      409,
      'Festgeschriebene Dokumente können nicht mehr geändert werden. Korrektur nur per Storno und neuem Dokument.',
    )
  }
  return row
}

function send(reply: FastifyReply, doc: (DocumentDetail & { etag: string }) | null, status = 200) {
  if (!doc) throw notFound('Das Dokument')
  const { etag, ...body } = doc
  return reply.status(status).header('etag', etag).send(body)
}

// ---- Creating documents -------------------------------------------------------------------------

interface ProjectFacts {
  hasContract: boolean
  hasProgressOrContract: boolean
  hasFinal: boolean
  nextProgressNo: number
}

async function projectFacts(tx: Tx, projectId: string): Promise<ProjectFacts> {
  const [facts] = await tx<ProjectFacts[]>`
    select
      exists (select 1 from document where project_id = ${projectId} and type = 'order_confirmation'
              and status <> 'cancelled') as "hasContract",
      exists (select 1 from document where project_id = ${projectId} and status <> 'cancelled'
              and (type = 'order_confirmation' or invoice_kind = 'progress')) as "hasProgressOrContract",
      exists (select 1 from document where project_id = ${projectId} and invoice_kind = 'final'
              and status <> 'cancelled') as "hasFinal",
      (select coalesce(max(progress_no), 0) + 1 from document
       where project_id = ${projectId} and invoice_kind = 'progress')::int as "nextProgressNo"`
  return facts as ProjectFacts
}

function optionsOf(facts: ProjectFacts): DocumentOption[] {
  const option = (
    type: DocumentOption['type'],
    invoiceKind: DocumentOption['invoiceKind'] = null,
    reason: string | null = null,
  ): DocumentOption => ({
    type,
    invoiceKind,
    available: reason === null,
    reason,
    progressNo: invoiceKind === 'progress' ? facts.nextProgressNo : null,
  })
  return [
    option('quote'),
    option('cost_estimate'),
    option('order_confirmation'),
    option(
      'change_order',
      null,
      facts.hasContract ? null : 'Ein Nachtrag braucht einen Hauptauftrag (Auftragsbestätigung).',
    ),
    option('delivery_note'),
    option('invoice', 'standard'),
    option('invoice', 'partial'),
    option('invoice', 'progress'),
    option(
      'invoice',
      'final',
      facts.hasFinal
        ? 'Für dieses Projekt gibt es bereits eine Schlussrechnung.'
        : facts.hasProgressOrContract
          ? null
          : 'Eine Schlussrechnung braucht einen Auftrag oder eine Abschlagsrechnung.',
    ),
    option('credit_note'),
  ]
}

function siteLine(site: {
  street: string | null
  postalCode: string | null
  city: string | null
}): string | null {
  const place = [site.postalCode, site.city].filter(Boolean).join(' ')
  return [site.street, place].filter(Boolean).join(', ') || null
}

async function createDocument(
  tx: Tx,
  auth: AuthContext,
  projectId: string,
  input: CreateDocumentRequest,
): Promise<string> {
  // Serialises document creation per project (progress numbers, change order numbers).
  const [project] = await tx<
    {
      name: string
      customerId: string | null
      street: string | null
      postalCode: string | null
      city: string | null
      startDate: string | null
      endDate: string | null
    }[]
  >`
    select name, customer_id as "customerId", site_street as street, site_postal_code as "postalCode",
           site_city as city, to_char(start_date, 'YYYY-MM-DD') as "startDate", to_char(end_date, 'YYYY-MM-DD') as "endDate"
    from project where id = ${projectId} for update`
  if (!project) throw notFound('Das Projekt')

  const facts = await projectFacts(tx, projectId)
  const wanted = optionsOf(facts).find(
    (o) => o.type === input.type && (o.invoiceKind ?? undefined) === input.invoiceKind,
  )
  if (!wanted) throw new HttpError(400, 'Diese Dokumentart gibt es nicht.')
  if (!wanted.available) throw new HttpError(409, wanted.reason as string)

  type Source = {
    id: string
    contactId: string | null
    placeOfPerformance: string | null
    introText: string | null
    closingText: string | null
    taxMode: string
    discountPercent: string | null
    subject: string | null
  }
  let source: Source | undefined
  if (input.sourceDocumentId) {
    ;[source] = await tx<Source[]>`
      select id, contact_id as "contactId", place_of_performance as "placeOfPerformance",
             intro_text as "introText", closing_text as "closingText", tax_mode as "taxMode",
             discount_percent::text as "discountPercent", subject
      from document where id = ${input.sourceDocumentId} and project_id = ${projectId}`
    if (!source) {
      throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
        sourceDocumentId: 'Das Ausgangsdokument gehört nicht zu diesem Projekt.',
      })
    }
  }

  const contactId = source ? source.contactId : project.customerId
  const [contact] = contactId
    ? await tx<
        {
          taxMode: string
          dueDays: number | null
          discountPercent: string | null
          discountDays: number | null
        }[]
      >`
        select c.tax_mode as "taxMode", pt.due_days as "dueDays",
               pt.cash_discount_percent::text as "discountPercent", pt.cash_discount_days as "discountDays"
        from contact c left join payment_term pt on pt.id = c.payment_term_id where c.id = ${contactId}`
    : []
  const [defaultTerm] = await tx<
    { dueDays: number; discountPercent: string | null; discountDays: number | null }[]
  >`
    select due_days as "dueDays", cash_discount_percent::text as "discountPercent",
           cash_discount_days as "discountDays"
    from payment_term where is_default limit 1`
  const term = contact?.dueDays != null ? contact : defaultTerm
  const billed = input.type === 'invoice' || input.type === 'credit_note'
  const templates = await tx<{ placement: 'intro' | 'closing'; body: string }[]>`
    select placement, body from text_template where document_type = ${input.type} and is_default`
  const template = (placement: 'intro' | 'closing') =>
    templates.find((t) => t.placement === placement)?.body ?? null

  const columns: Record<string, unknown> = {
    tenant_id: auth.tenantId,
    project_id: projectId,
    type: input.type,
    invoice_kind: input.invoiceKind ?? null,
    progress_no: input.invoiceKind === 'progress' ? facts.nextProgressNo : null,
    progress_billing_mode: input.invoiceKind === 'progress' ? 'cumulative' : null,
    subject: input.subject ?? source?.subject ?? project.name,
    place_of_performance: source ? source.placeOfPerformance : siteLine(project),
    contact_id: contactId,
    tax_mode: source?.taxMode ?? contact?.taxMode ?? 'standard',
    intro_text: source ? source.introText : template('intro'),
    closing_text: source ? source.closingText : template('closing'),
    discount_percent: source?.discountPercent ?? null,
    payment_due_days: billed ? (term?.dueDays ?? null) : null,
    cash_discount_percent: billed ? (term?.discountPercent ?? null) : null,
    cash_discount_days: billed ? (term?.discountDays ?? null) : null,
    service_from: billed ? project.startDate : null,
    service_to: billed ? project.endDate : null,
    source_document_id: source?.id ?? null,
    created_by: auth.userId,
  }
  const [created] = await tx<{ id: string }[]>`insert into document ${tx(columns)} returning id`
  const documentId = (created as { id: string }).id

  if (input.type === 'change_order') {
    // The latest order confirmation is the main contract (Hauptauftrag).
    await tx`
      insert into change_order_meta (document_id, tenant_id, contract_document_id, number, basis, reason)
      select ${documentId}, ${auth.tenantId}, c.id,
             (select coalesce(max(m.number), 0) + 1 from change_order_meta m where m.contract_document_id = c.id),
             ${input.basis ?? 'additional_work'}, ${input.reason ?? null}
      from document c
      where c.project_id = ${projectId} and c.type = 'order_confirmation' and c.status <> 'cancelled'
      order by c.created_at desc limit 1`
  }

  if (source) await copyItems(tx, source.id, documentId)
  await recalculate(tx, documentId)
  return documentId
}

/** Copies the outline of a document (Zusammenhängend erstellen), keeping the reference per item. */
async function copyItems(tx: Tx, fromId: string, toId: string) {
  const order = outline(await loadItems(tx, fromId))
  const newIds = new Map<string, string>()
  for (const { row } of order) {
    const [created] = await tx<{ id: string }[]>`
      insert into document_item (tenant_id, document_id, parent_id, sort, position_type, oz, quantity, unit_id,
                                 unit_symbol, unit_unece_code, short_text, long_text, show_long_text, calc_mode,
                                 unit_price_cents, discount_percent, total_cents, tax_rate_percent, tax_category,
                                 catalog_item_id, source_item_id, image_file_id)
      select tenant_id, ${toId}, ${row.parentId ? (newIds.get(row.parentId) ?? null) : null}, sort, position_type, oz,
             quantity, unit_id, unit_symbol, unit_unece_code, short_text, long_text, show_long_text, calc_mode,
             unit_price_cents, discount_percent, total_cents, tax_rate_percent, tax_category,
             catalog_item_id, id, image_file_id
      from document_item where id = ${row.id}
      returning id`
    newIds.set(row.id, (created as { id: string }).id)
  }
}

// ---- Items ----------------------------------------------------------------------------------------

async function unitSnapshot(tx: Tx, unitId: string) {
  const [unit] = await tx<{ symbol: string; unece: string }[]>`
    select symbol, unece_code as unece from unit where id = ${unitId} and is_active`
  if (!unit) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      unitId: 'Unbekannte Einheit.',
    })
  }
  return unit
}

async function levelOf(tx: Tx, itemId: string): Promise<number> {
  const [row] = await tx<{ level: number }[]>`
    with recursive up as (
      select id, parent_id, 0 as level from document_item where id = ${itemId}
      union all
      select i.id, i.parent_id, up.level + 1 from document_item i join up on i.id = up.parent_id
    )
    select max(level)::int as level from up`
  return row?.level ?? 0
}

export function registerDocumentRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/units', async (request): Promise<UnitSummary[]> => {
    const auth = requirePermission(request)
    return inTenant(
      services,
      auth,
      (tx) => tx<UnitSummary[]>`
        select id, symbol, name, dimension from unit where is_active
        order by array_position(array['count','length','area','volume','mass','time','lump_sum','container','power'], dimension),
                 symbol`,
    )
  })

  app.get('/api/v1/tax-rates', async (request): Promise<TaxRateSummary[]> => {
    const auth = requirePermission(request)
    return inTenant(
      services,
      auth,
      (tx) => tx<TaxRateSummary[]>`
        select id, name, trim_scale(percent)::text as percent, category_code as "categoryCode",
               is_default as "isDefault"
        from tax_rate where valid_to is null or valid_to >= current_date
        order by is_default desc, percent desc, name`,
    )
  })

  app.get('/api/v1/projects/:id/documents', async (request): Promise<DocumentSummary[]> => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(projectParam, request.params)
    return inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      return tx<DocumentSummary[]>`
        select ${summaryColumns(tx)} from ${fromDocuments(tx)}
        where d.project_id = ${id}
        order by array_position(array['quote','cost_estimate','order_confirmation','change_order',
                                      'delivery_note','invoice','credit_note'], d.type),
                 d.progress_no nulls last, d.created_at, d.id`
    })
  })

  app.get('/api/v1/projects/:id/document-options', async (request): Promise<DocumentOption[]> => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(projectParam, request.params)
    return inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      return optionsOf(await projectFacts(tx, id))
    })
  })

  app.post('/api/v1/projects/:id/documents', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(projectParam, request.params)
    const input = parse(createDocumentRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      const project = await requireVisibleProject(tx, auth, id)
      if (project.archived) {
        throw new HttpError(409, 'Das Projekt ist archiviert. Bitte zuerst wiederherstellen.')
      }
      const documentId = await createDocument(tx, auth, id, input)
      return loadDocument(tx, auth, documentId)
    })
    reply.header('location', `/api/v1/documents/${doc?.id}`)
    return send(reply, doc, 201)
  })

  app.get('/api/v1/documents/:id', async (request, reply) => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(documentParam, request.params)
    return send(reply, await inTenant(services, auth, (tx) => loadDocument(tx, auth, id)))
  })

  app.patch('/api/v1/documents/:id', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(documentParam, request.params)
    const input = parse(updateDocumentRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      const current = await lockDraft(tx, auth, id)
      checkIfMatch(request.headers['if-match'], current.updatedAt)
      if (
        input.contactId &&
        !(await tx`select 1 from contact where id = ${input.contactId}`).length
      ) {
        throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
          contactId: 'Unbekannter Kontakt.',
        })
      }
      const map: Record<string, string> = {
        subject: 'subject',
        documentDate: 'document_date',
        serviceFrom: 'service_from',
        serviceTo: 'service_to',
        placeOfPerformance: 'place_of_performance',
        contactId: 'contact_id',
        introText: 'intro_text',
        closingText: 'closing_text',
        paymentDueDays: 'payment_due_days',
        discountPercent: 'discount_percent',
        taxMode: 'tax_mode',
      }
      const columns: Record<string, unknown> = {}
      for (const [key, column] of Object.entries(map)) {
        const value = input[key as keyof typeof input]
        if (value !== undefined) columns[column] = value
      }
      if (Object.keys(columns).length) {
        await tx`update document set ${tx(columns)} where id = ${id}`.catch(
          (error: { code?: string }) => {
            if (error.code === '23514') {
              throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
                serviceTo: 'Das Ende darf nicht vor dem Beginn liegen.',
              })
            }
            throw error
          },
        )
      }
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return send(reply, doc)
  })

  app.delete('/api/v1/documents/:id', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(documentParam, request.params)
    await inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      const [usage] = await tx<{ derived: boolean; contract: boolean }[]>`
        select exists (select 1 from document where source_document_id = ${id}) as derived,
               exists (select 1 from change_order_meta where contract_document_id = ${id}) as contract`
      if (usage?.derived || usage?.contract) {
        throw new HttpError(
          409,
          usage.contract
            ? 'Zu diesem Auftrag gibt es Nachträge. Bitte zuerst die Nachträge löschen.'
            : 'Aus diesem Dokument wurden weitere Dokumente erstellt. Bitte zuerst diese löschen.',
        )
      }
      await tx`delete from document where id = ${id}`
    })
    return reply.status(204).send()
  })

  // ---- Positions ----------------------------------------------------------------------------------

  app.post('/api/v1/documents/:id/items', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(documentParam, request.params)
    const input = parse(createItemRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      const parentId = input.parentId ?? null
      if (parentId) {
        const [parent] = await tx<{ positionType: string }[]>`
          select position_type as "positionType" from document_item where id = ${parentId} and document_id = ${id}`
        if (parent?.positionType !== 'title') {
          throw new HttpError(400, 'Positionen können nur unter einem Titel eingefügt werden.', {
            parentId: 'Unbekannter Titel.',
          })
        }
        if (input.positionType === 'title' && (await levelOf(tx, parentId)) >= MAX_TITLE_LEVEL) {
          throw new HttpError(400, 'Titel können höchstens zwei Ebenen tief gegliedert werden.')
        }
      }
      const priced = PRICED.has(input.positionType)
      let unitId = input.unitId ?? null
      let quantity = input.quantity ?? null
      if (input.positionType === 'lump_sum') {
        quantity ??= '1'
        if (!unitId) {
          const [psch] = await tx<{ id: string }[]>`select id from unit where symbol = 'psch'`
          unitId = psch?.id ?? null
        }
      }
      const unit = priced && unitId ? await unitSnapshot(tx, unitId) : null
      let taxRate = input.taxRatePercent ?? null
      if (priced && taxRate === null) {
        const [rate] = await tx<{ percent: string }[]>`
          select trim_scale(percent)::text as percent from tax_rate where is_default limit 1`
        taxRate = rate?.percent ?? '19'
      }
      const [{ sort } = { sort: 10 }] = await tx<{ sort: number }[]>`
        select (coalesce(max(sort), 0) + 10)::int as sort from document_item
        where document_id = ${id} and parent_id is not distinct from ${parentId}::uuid`
      await tx`
        insert into document_item ${tx({
          tenant_id: auth.tenantId,
          document_id: id,
          parent_id: parentId,
          sort,
          position_type: input.positionType,
          short_text: input.shortText ?? null,
          long_text: input.longText ?? null,
          quantity: priced ? quantity : null,
          unit_id: priced ? unitId : null,
          unit_symbol: unit?.symbol ?? null,
          unit_unece_code: unit?.unece ?? null,
          unit_price_cents: priced ? (input.unitPriceCents ?? 0) : null,
          discount_percent: priced ? (input.discountPercent ?? null) : null,
          tax_rate_percent: priced ? taxRate : null,
          calc_mode: priced ? 'unit_price' : null,
        })}`
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return send(reply, doc, 201)
  })

  app.patch('/api/v1/documents/:id/items/:itemId', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id, itemId } = parse(itemParam, request.params)
    const input = parse(updateItemRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      const [item] = await tx<{ positionType: string }[]>`
        select position_type as "positionType" from document_item where id = ${itemId} and document_id = ${id}`
      if (!item) throw notFound('Die Position')
      const priced = PRICED.has(item.positionType)
      const columns: Record<string, unknown> = {}
      if (input.shortText !== undefined) {
        if (!input.shortText && (priced || item.positionType === 'title')) {
          throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
            shortText: 'Kurztext fehlt.',
          })
        }
        columns.short_text = input.shortText
      }
      if (input.longText !== undefined) columns.long_text = input.longText
      if (priced) {
        if (input.quantity !== undefined) {
          if (input.quantity === null) {
            throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
              quantity: 'Menge fehlt.',
            })
          }
          columns.quantity = input.quantity
        }
        if (input.unitId !== undefined) {
          if (input.unitId === null) {
            throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
              unitId: 'Einheit fehlt.',
            })
          }
          const unit = await unitSnapshot(tx, input.unitId)
          Object.assign(columns, {
            unit_id: input.unitId,
            unit_symbol: unit.symbol,
            unit_unece_code: unit.unece,
          })
        }
        if (input.unitPriceCents !== undefined) columns.unit_price_cents = input.unitPriceCents ?? 0
        if (input.discountPercent !== undefined) columns.discount_percent = input.discountPercent
        if (input.taxRatePercent !== undefined) {
          if (input.taxRatePercent === null) {
            throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
              taxRatePercent: 'Steuersatz fehlt.',
            })
          }
          columns.tax_rate_percent = input.taxRatePercent
        }
      }
      if (Object.keys(columns).length) {
        await tx`update document_item set ${tx(columns)} where id = ${itemId}`
      }
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return send(reply, doc)
  })

  app.post('/api/v1/documents/:id/items/:itemId/move', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id, itemId } = parse(itemParam, request.params)
    const { direction } = parse(moveItemRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      const [item] = await tx<{ parentId: string | null; sort: number }[]>`
        select parent_id as "parentId", sort from document_item where id = ${itemId} and document_id = ${id}`
      if (!item) throw notFound('Die Position')
      const [neighbour] = await tx<{ id: string; sort: number }[]>`
        select id, sort from document_item
        where document_id = ${id} and parent_id is not distinct from ${item.parentId}::uuid and id <> ${itemId}
          and ${direction === 'up' ? tx`sort <= ${item.sort}` : tx`sort >= ${item.sort}`}
        order by ${direction === 'up' ? tx`sort desc` : tx`sort asc`}, id limit 1`
      if (neighbour) {
        // Distinct sort values even if both were equal before.
        const [a, b] =
          neighbour.sort === item.sort
            ? direction === 'up'
              ? [item.sort - 1, item.sort]
              : [item.sort + 1, item.sort]
            : [neighbour.sort, item.sort]
        await tx`update document_item set sort = ${a} where id = ${itemId}`
        await tx`update document_item set sort = ${b} where id = ${neighbour.id}`
        await recalculate(tx, id)
      }
      return loadDocument(tx, auth, id)
    })
    return send(reply, doc)
  })

  app.delete('/api/v1/documents/:id/items/:itemId', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id, itemId } = parse(itemParam, request.params)
    const doc = await inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      // Positions below a title are removed with it (ON DELETE CASCADE).
      const deleted =
        await tx`delete from document_item where id = ${itemId} and document_id = ${id}`
      if (!deleted.count) throw notFound('Die Position')
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return send(reply, doc)
  })
}
