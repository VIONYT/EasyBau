import { createHash } from 'node:crypto'
import type { Tx } from '@opc/db'
import {
  CalculationError,
  COUNTED_POSITION_TYPES,
  type CostLineInput,
  calculateDocumentTotals,
  calculateItem,
  Decimal,
  type DocumentLineInput,
  isConvertible,
  type PositionType,
  priceItem,
  rateForTimeUnit,
  roundTo,
  type TaxCategory,
} from '@opc/domain'
import {
  type CostKind,
  type CreateDocumentRequest,
  calculationRequest,
  convertDocumentRequest,
  createDocumentRequest,
  createItemRequest,
  type DocumentDetail,
  type DocumentItem,
  type DocumentOption,
  type DocumentSummary,
  type DocumentTotals,
  documentStatusRequest,
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
         else json_build_object('number', co.number, 'basis', co.basis, 'status', co.status) end as "changeOrder",
    (select json_build_object('id', s.id, 'number', s.number) from document s
      where s.cancels_document_id = d.id and s.finalized_at is not null) as "cancelledBy",
    (select json_build_object('id', o.id, 'number', o.number) from document o
      where o.id = d.cancels_document_id) as "cancels"`
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
  unitDecimals: number | null
  unitPriceCents: string | null
  discountPercent: string | null
  totalCents: string | null
  taxRatePercent: string | null
  taxCategory: TaxCategory | null
  fromMeasurement: boolean
  calcMode: 'unit_price' | 'total_price' | null
}

interface CostRow {
  id: string
  itemId: string
  kind: CostKind
  description: string | null
  quantity: string
  unitId: string | null
  unitSymbol: string | null
  unitDecimals: number | null
  unitCostCents: string
  markupPercent: string
}

async function loadItems(tx: Tx, documentId: string): Promise<ItemRow[]> {
  return tx<ItemRow[]>`
    select id, parent_id as "parentId", sort, position_type as "positionType", oz,
           short_text as "shortText", long_text as "longText",
           trim_scale(quantity)::text as quantity, unit_id as "unitId", unit_symbol as "unitSymbol",
           (select u.decimals from unit u where u.id = unit_id)::int as "unitDecimals",
           unit_price_cents::text as "unitPriceCents", trim_scale(discount_percent)::text as "discountPercent",
           total_cents::text as "totalCents", trim_scale(tax_rate_percent)::text as "taxRatePercent",
           tax_category as "taxCategory", quantity_from_measurement as "fromMeasurement",
           calc_mode as "calcMode"
    from document_item where document_id = ${documentId}`
}

async function loadCostLines(tx: Tx, documentId: string): Promise<Map<string, CostRow[]>> {
  const rows = await tx<CostRow[]>`
    select c.id, c.document_item_id as "itemId", c.cost_kind as kind, c.description,
           trim_scale(c.quantity)::text as quantity, c.unit_id as "unitId", u.symbol as "unitSymbol",
           u.decimals as "unitDecimals", c.unit_cost_cents::text as "unitCostCents",
           trim_scale(c.markup_percent)::text as "markupPercent"
    from item_calc_component c left join unit u on u.id = c.unit_id
    where c.document_id = ${documentId}
    order by c.sort, c.id`
  const byItem = new Map<string, CostRow[]>()
  for (const row of rows) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row])
  return byItem
}

/** Change orders number their positions N01.1, N01.2 … (DESIGN.md §4.4). */
async function ozPrefixOf(tx: Tx, documentId: string): Promise<string> {
  const [meta] = await tx<{ number: number }[]>`
    select number from change_order_meta where document_id = ${documentId}`
  return meta ? `N${String(meta.number).padStart(2, '0')}` : ''
}

/** Depth-first order of the outline with level and Ordnungszahl (1, 1.1, 1.1.1 …). */
function outline(
  rows: ItemRow[],
  rootPrefix = '',
): { row: ItemRow; level: number; oz: string | null }[] {
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
  walk(null, rootPrefix, 0)
  return result
}

/** Cost line as input for the domain: labor in a time unit is stored as hourly rate. */
function costInput(line: CostRow): CostLineInput {
  const timeUnit = line.unitSymbol && isConvertible(line.unitSymbol, 'Std')
  return {
    kind: line.kind,
    quantity: line.quantity,
    ...(line.unitSymbol ? { unit: line.unitSymbol } : {}),
    unitCostCents:
      line.kind === 'labor' && timeUnit
        ? rateForTimeUnit(line.unitCostCents, line.unitSymbol as string)
        : line.unitCostCents,
    markupPercent: line.markupPercent,
  }
}

/** Price of a position: from its Kalkulation if it has cost lines, otherwise EP as entered. */
function priceOf(row: ItemRow, costs: CostRow[] | undefined) {
  if (!PRICED.has(row.positionType)) return null
  const discount = row.discountPercent ? { discountPercent: row.discountPercent } : {}
  try {
    if (costs?.length) {
      return calculateItem({
        quantity: row.quantity ?? '0',
        calcMode: row.calcMode ?? 'unit_price',
        costLines: costs.map(costInput),
        ...discount,
      })
    }
    return {
      ...priceItem({
        quantity: row.quantity ?? '0',
        unitPriceCents: row.unitPriceCents ?? '0',
        ...discount,
      }),
      costCents: null,
    }
  } catch (error) {
    return calculationError(error)
  }
}

function calculationError(error: unknown): never {
  if (error instanceof CalculationError || error instanceof RangeError) {
    throw new HttpError(400, error.message)
  }
  throw error
}

/**
 * Recomputes numbering, prices (from the Kalkulation where present), VAT per rate and document
 * totals of a draft and stores them. The server always calculates itself; the client only shows
 * what it gets back (rule 11 analog).
 */
export async function recalculate(tx: Tx, documentId: string): Promise<void> {
  const [doc] = await tx<{ taxMode: string; discountPercent: string | null }[]>`
    select tax_mode as "taxMode", discount_percent::text as "discountPercent"
    from document where id = ${documentId}`
  if (!doc) return
  const rows = await loadItems(tx, documentId)
  const costs = await loadCostLines(tx, documentId)
  const prefix = await ozPrefixOf(tx, documentId)
  const lines: DocumentLineInput[] = []
  for (const { row, oz } of outline(rows, prefix)) {
    const price = priceOf(row, costs.get(row.id))
    const total = price ? price.totalCents : null
    const totalText = total === null ? null : total.toString()
    const unitPrice =
      price && costs.get(row.id)?.length ? price.unitPriceCents.toString() : row.unitPriceCents
    if (oz !== row.oz || totalText !== row.totalCents || unitPrice !== row.unitPriceCents) {
      await tx`update document_item set oz = ${oz}, total_cents = ${totalText}, unit_price_cents = ${unitPrice}
               where id = ${row.id}`
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
  costs: Map<string, CostRow[]>,
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
  // Kalkulation of the counted positions (Soll-Kosten, Soll-Stunden).
  let costCents = 0n
  let laborHundredths = 0n
  let uncalculatedCount = 0
  for (const row of rows) {
    if (!COUNTED_POSITION_TYPES.has(row.positionType as PositionType)) continue
    const lines = costs.get(row.id)
    if (!lines?.length) {
      uncalculatedCount += 1
      continue
    }
    const calc = priceOf(row, lines) as ReturnType<typeof calculateItem>
    costCents += calc.costCents
    laborHundredths += BigInt(roundTo(calc.laborHours, 2).replace('.', ''))
  }
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
    costCents: Number(costCents),
    marginCents: Number(totals.netCents - costCents),
    laborHours: roundTo(new Decimal(laborHundredths.toString()).div(100), 2),
    uncalculatedCount,
  }
}

// ---- Letter header: Firma and Empfänger ---------------------------------------------------------

type Issuer = DocumentDetail['issuer']

async function liveIssuer(tx: Tx): Promise<Issuer> {
  const [t] = await tx<
    {
      name: string
      street: string | null
      postalCode: string | null
      city: string | null
      email: string | null
      phone: string | null
      website: string | null
      vatId: string | null
      taxNumber: string | null
      registerCourt: string | null
      registerNumber: string | null
      managerTitle: string | null
      managerName: string | null
    }[]
  >`
    select name, street, postal_code as "postalCode", city, email, phone, website, vat_id as "vatId",
           tax_number as "taxNumber", register_court as "registerCourt", register_number as "registerNumber",
           manager_title as "managerTitle", manager_name as "managerName"
    from tenant where id = current_tenant_id()`
  if (!t) return { name: '', lines: [], contact: [], legal: [] }
  const place = [t.postalCode, t.city].filter(Boolean).join(' ')
  return {
    name: t.name,
    lines: [t.street, place].filter((v): v is string => !!v),
    contact: [t.phone ? `Tel. ${t.phone}` : null, t.email, t.website].filter(
      (v): v is string => !!v,
    ),
    legal: [
      t.managerName ? `${t.managerTitle ?? 'Geschäftsführung'}: ${t.managerName}` : null,
      t.registerCourt && t.registerNumber ? `${t.registerCourt} ${t.registerNumber}` : null,
      t.vatId ? `USt-IdNr. ${t.vatId}` : null,
      t.taxNumber ? `Steuernummer ${t.taxNumber}` : null,
    ].filter((v): v is string => !!v),
  }
}

/** Empfänger: billing address (Rechnungsempfänger) if present, otherwise the main address. */
async function liveRecipient(
  tx: Tx,
  contactId: string | null,
): Promise<DocumentDetail['recipient']> {
  if (!contactId) return null
  const [c] = await tx<
    { name: string }[]
  >`select display_name as name from contact where id = ${contactId}`
  if (!c) return null
  const [a] = await tx<
    {
      recipientBlock: string | null
      street: string | null
      streetExtra: string | null
      postalCode: string | null
      city: string | null
      countryCode: string
    }[]
  >`
    select recipient_block as "recipientBlock", street, street_extra as "streetExtra",
           postal_code as "postalCode", city, country_code as "countryCode"
    from contact_address where contact_id = ${contactId} and kind in ('billing', 'main')
    order by (kind = 'billing') desc limit 1`
  if (!a) return { name: c.name, lines: [] }
  const block =
    a.recipientBlock
      ?.split('\n')
      .map((l) => l.trim())
      .filter(Boolean) ?? []
  return {
    name: block[0] ?? c.name,
    lines: [
      ...block.slice(1),
      a.street,
      a.streetExtra,
      [a.postalCode, a.city].filter(Boolean).join(' ') || null,
      a.countryCode !== 'DE' ? a.countryCode : null,
    ].filter((v): v is string => !!v),
  }
}

// ---- Loading ------------------------------------------------------------------------------------

type DocumentRow = Omit<
  DocumentDetail,
  'items' | 'totals' | 'issuer' | 'recipient' | 'changeOrderInfo' | 'canConvertToChangeOrder'
> & {
  updatedRaw: Date
  contactId: string | null
  issuerSnapshot: Issuer | null
  recipientSnapshot: DocumentDetail['recipient'] | null
}

export async function loadDocument(
  tx: Tx,
  auth: AuthContext,
  id: string,
): Promise<(DocumentDetail & { etag: string }) | null> {
  const [row] = await tx<DocumentRow[]>`
    select ${summaryColumns(tx)}, d.updated_at as "updatedRaw", ${ISO(tx, 'd.finalized_at')} as "finalizedAt",
           json_build_object('id', p.id, 'number', p.number, 'name', p.name) as project,
           case when c.id is null then null else json_build_object('id', c.id, 'displayName', c.display_name) end as contact,
           d.contact_id as "contactId",
           d.place_of_performance as "placeOfPerformance",
           ${DATE(tx, 'd.service_from')} as "serviceFrom", ${DATE(tx, 'd.service_to')} as "serviceTo",
           ${DATE(tx, 'd.valid_until')} as "validUntil",
           d.intro_text as "introText", d.closing_text as "closingText", d.payment_due_days as "paymentDueDays",
           trim_scale(d.discount_percent)::text as "discountPercent", d.tax_mode as "taxMode",
           d.source_document_id as "sourceDocumentId",
           d.issuer_snapshot as "issuerSnapshot", d.recipient_snapshot as "recipientSnapshot"
    from ${fromDocuments(tx)}
    left join contact c on c.id = d.contact_id
    where d.id = ${id} and ${projectVisibility(tx, auth)}`
  if (!row) return null
  const rows = await loadItems(tx, id)
  const costs = await loadCostLines(tx, id)
  const { updatedRaw, contactId, issuerSnapshot, recipientSnapshot, ...doc } = row
  const items: DocumentItem[] = outline(rows).map(({ row: r, level }) => {
    const lines = costs.get(r.id) ?? []
    const calc = lines.length ? (priceOf(r, lines) as ReturnType<typeof calculateItem>) : null
    return {
      id: r.id,
      parentId: r.parentId,
      positionType: r.positionType,
      oz: r.oz,
      level,
      shortText: r.shortText,
      longText: r.longText,
      quantity: r.quantity,
      unit: r.unitId
        ? { id: r.unitId, symbol: r.unitSymbol ?? '', decimals: r.unitDecimals ?? 2 }
        : null,
      unitPriceCents: r.unitPriceCents === null ? null : Number(r.unitPriceCents),
      discountPercent: r.discountPercent,
      totalCents: r.totalCents === null ? null : Number(r.totalCents),
      taxRatePercent: r.taxRatePercent,
      fromMeasurement: r.fromMeasurement,
      calcMode: r.calcMode,
      costLines: lines.map((l) => ({
        id: l.id,
        kind: l.kind,
        description: l.description,
        quantity: l.quantity,
        unit: l.unitId
          ? { id: l.unitId, symbol: l.unitSymbol ?? '', decimals: l.unitDecimals ?? 2 }
          : null,
        unitCostCents: Number(l.unitCostCents),
        markupPercent: l.markupPercent,
      })),
      calculation: calc
        ? {
            costCents: Number(calc.costCents),
            marginCents: Number(calc.marginCents),
            marginPercent: calc.marginPercent,
            laborHours: roundTo(calc.laborHours, 2),
          }
        : null,
    }
  })
  const [info] = await tx<{ contractId: string; contractLabel: string; reason: string | null }[]>`
    select m.contract_document_id as "contractId",
           coalesce(c.number, 'Auftragsbestätigung (Entwurf)') as "contractLabel", m.reason
    from change_order_meta m join document c on c.id = m.contract_document_id
    where m.document_id = ${id}`
  const canConvert =
    doc.status === 'draft' &&
    (doc.type === 'change_order' ||
      (doc.type === 'quote' && (await projectFacts(tx, doc.projectId)).hasContract))
  return {
    ...doc,
    issuer: issuerSnapshot ?? (await liveIssuer(tx)),
    recipient: recipientSnapshot ?? (await liveRecipient(tx, contactId)),
    changeOrderInfo: info ?? null,
    canConvertToChangeOrder: canConvert,
    items,
    totals: totalsOf(rows, costs, doc),
    etag: etagOf(updatedRaw),
  }
}

/** Locks a draft for changes; finalized documents are immutable (rule 2). */
export async function lockDraft(tx: Tx, auth: AuthContext, id: string) {
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

export function sendDocument(
  reply: FastifyReply,
  doc: (DocumentDetail & { etag: string }) | null,
  status = 200,
) {
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
    const newId = (created as { id: string }).id
    newIds.set(row.id, newId)
    // The Kalkulation travels with the position (Angebot → Auftrag → Rechnung).
    await tx`
      insert into item_calc_component (tenant_id, document_id, document_item_id, sort, cost_kind, quantity, unit_id,
                                       description, unit_cost_cents, markup_percent, wage_group_id, catalog_item_id)
      select tenant_id, ${toId}, ${newId}, sort, cost_kind, quantity, unit_id, description, unit_cost_cents,
             markup_percent, wage_group_id, catalog_item_id
      from item_calc_component where document_item_id = ${row.id}`
  }
}

// ---- Items ----------------------------------------------------------------------------------------

export async function unitSnapshot(tx: Tx, unitId: string) {
  const [unit] = await tx<{ symbol: string; unece: string; decimals: number }[]>`
    select symbol, unece_code as unece, decimals from unit where id = ${unitId} and is_active`
  if (!unit) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      unitId: 'Unbekannte Einheit.',
    })
  }
  return unit
}

/**
 * Handwerksregel: a quantity has at most the decimals of its unit (m² 2, m³ and t 3, Stück 0),
 * so Menge × EP on the document always equals the Gesamtpreis.
 */
export function checkQuantityDecimals(
  quantity: string | null,
  unit: { symbol: string; decimals: number } | null,
) {
  if (quantity === null || !unit) return
  const fraction = (quantity.split('.')[1] ?? '').replace(/0+$/, '')
  if (fraction.length > unit.decimals) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      quantity:
        unit.decimals === 0
          ? `Menge in ${unit.symbol} bitte ohne Nachkommastellen angeben.`
          : `Menge in ${unit.symbol}: höchstens ${unit.decimals} Nachkommastellen.`,
    })
  }
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
        select id, symbol, name, dimension, decimals from unit where is_active
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
    return sendDocument(reply, doc, 201)
  })

  app.get('/api/v1/documents/:id', async (request, reply) => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(documentParam, request.params)
    return sendDocument(reply, await inTenant(services, auth, (tx) => loadDocument(tx, auth, id)))
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
        validUntil: 'valid_until',
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
              throw new HttpError(
                400,
                'Die Eingaben sind unvollständig oder ungültig.',
                String((error as { message?: string }).message).includes('valid_until')
                  ? { validUntil: 'Die Bindefrist darf nicht vor dem Datum liegen.' }
                  : { serviceTo: 'Das Ende darf nicht vor dem Beginn liegen.' },
              )
            }
            throw error
          },
        )
      }
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
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
      checkQuantityDecimals(priced ? quantity : null, unit)
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
    return sendDocument(reply, doc, 201)
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
          columns.quantity_from_measurement = false
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
      if (priced && (input.quantity !== undefined || input.unitId !== undefined)) {
        const [after] = await tx<{ quantity: string | null; symbol: string; decimals: number }[]>`
          select trim_scale(i.quantity)::text as quantity, u.symbol, u.decimals
          from document_item i join unit u on u.id = i.unit_id where i.id = ${itemId}`
        checkQuantityDecimals(after?.quantity ?? null, after ?? null)
      }
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
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
    return sendDocument(reply, doc)
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
    return sendDocument(reply, doc)
  })

  // ---- Kalkulation of a position (DESIGN.md §4.2) ------------------------------------------------

  app.post('/api/v1/documents/:id/items/:itemId/calculation', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id, itemId } = parse(itemParam, request.params)
    const input = parse(calculationRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      const [item] = await tx<{ positionType: string }[]>`
        select position_type as "positionType" from document_item where id = ${itemId} and document_id = ${id}`
      if (!item) throw notFound('Die Position')
      if (!PRICED.has(item.positionType)) {
        throw new HttpError(400, 'Nur Positionen mit Preis können kalkuliert werden.')
      }
      const unitIds = [...new Set(input.lines.map((l) => l.unitId).filter((v): v is string => !!v))]
      if (unitIds.length) {
        const found = await tx`select id from unit where id in ${tx(unitIds)} and is_active`
        if (found.length !== unitIds.length) {
          throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
            lines: 'Unbekannte Einheit.',
          })
        }
      }
      // Company defaults (Einstellungen › Zuschläge) for lines without their own markup.
      const defaults = new Map(
        (
          await tx<{ kind: string; percent: string }[]>`
            select cost_kind as kind, percent::text as percent from surcharge`
        ).map((r) => [r.kind, r.percent]),
      )
      await tx`delete from item_calc_component where document_item_id = ${itemId}`
      for (const [index, line] of input.lines.entries()) {
        await tx`
          insert into item_calc_component ${tx({
            tenant_id: auth.tenantId,
            document_id: id,
            document_item_id: itemId,
            sort: (index + 1) * 10,
            cost_kind: line.kind,
            description: line.description ?? null,
            quantity: line.quantity,
            unit_id: line.unitId ?? null,
            unit_cost_cents: line.unitCostCents,
            markup_percent: line.markupPercent ?? defaults.get(line.kind) ?? '0',
          })}`
      }
      await tx`update document_item set calc_mode = ${input.calcMode} where id = ${itemId}`
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
  })

  // ---- Schalter „Nachtragsangebot“: quote ↔ change order while it is a draft -----------------------

  app.post('/api/v1/documents/:id/convert', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(documentParam, request.params)
    const input = parse(convertDocumentRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      const current = await lockDraft(tx, auth, id)
      const [d] = await tx<{ type: string }[]>`select type from document where id = ${id}`
      if (!d || !['quote', 'change_order'].includes(d.type)) {
        throw new HttpError(409, 'Nur Angebote und Nachtragsangebote lassen sich umschalten.')
      }
      if (d.type === input.to) return loadDocument(tx, auth, id)
      if (input.to === 'change_order') {
        await tx`select 1 from project where id = ${current.projectId} for update`
        if (!(await projectFacts(tx, current.projectId)).hasContract) {
          throw new HttpError(409, 'Ein Nachtrag braucht einen Hauptauftrag (Auftragsbestätigung).')
        }
        await tx`update document set type = 'change_order' where id = ${id}`
        await tx`
          insert into change_order_meta (document_id, tenant_id, contract_document_id, number, basis, reason)
          select ${id}, ${auth.tenantId}, c.id,
                 (select coalesce(max(m.number), 0) + 1 from change_order_meta m where m.contract_document_id = c.id),
                 ${input.basis ?? 'additional_work'}, ${input.reason ?? null}
          from document c
          where c.project_id = ${current.projectId} and c.type = 'order_confirmation' and c.status <> 'cancelled'
          order by c.created_at desc limit 1`
      } else {
        await tx`delete from change_order_meta where document_id = ${id}`
        await tx`update document set type = 'quote' where id = ${id}`
      }
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
  })

  // ---- Fertigstellen: number, snapshots, content hash; afterwards unchangeable (rule 2) ------------

  app.post('/api/v1/documents/:id/finalize', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(documentParam, request.params)
    const doc = await inTenant(services, auth, async (tx) => {
      const current = await lockDraft(tx, auth, id)
      const [d] = await tx<{ type: string; contactId: string | null; documentDate: string }[]>`
        select type, contact_id as "contactId", to_char(document_date, 'YYYY-MM-DD') as "documentDate"
        from document where id = ${id}`
      if (!d) throw notFound('Das Dokument')
      if (d.type === 'invoice' || d.type === 'credit_note') {
        throw new HttpError(
          409,
          'Rechnungen und Gutschriften werden mit der E-Rechnung festgeschrieben (folgt in einem der nächsten Schritte).',
        )
      }
      if (!d.contactId) {
        throw new HttpError(400, 'Bitte zuerst einen Empfänger wählen.', {
          contactId: 'Empfänger fehlt.',
        })
      }
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from document_item
        where document_id = ${id} and position_type in ('item', 'alternative', 'optional', 'lump_sum')`
      if (!count?.n) throw new HttpError(409, 'Das Dokument enthält noch keine Positionen.')

      let number: string
      if (d.type === 'change_order') {
        const [meta] = await tx<{ n: number; contractNumber: string | null }[]>`
          select m.number as n, c.number as "contractNumber"
          from change_order_meta m join document c on c.id = m.contract_document_id
          where m.document_id = ${id}`
        if (!meta?.contractNumber) {
          throw new HttpError(
            409,
            'Bitte zuerst die Auftragsbestätigung (Hauptauftrag) fertigstellen.',
          )
        }
        number = `${meta.contractNumber}/N${String(meta.n).padStart(2, '0')}`
      } else {
        const [next] = await tx<
          { n: string }[]
        >`select next_number(${d.type}, ${d.documentDate}::date) as n`
        number = (next as { n: string }).n
      }
      await recalculate(tx, id)
      const preview = await loadDocument(tx, auth, id)
      if (!preview) throw notFound('Das Dokument')
      const { etag: _, updatedAt: __, ...content } = { ...preview, number }
      const hash = createHash('sha256').update(JSON.stringify(content)).digest()
      await tx`
        update document set number = ${number}, status = 'finalized', finalized_at = now(),
               finalized_by = ${auth.userId}, content_hash = ${hash},
               issuer_snapshot = ${tx.json(preview.issuer as never)},
               recipient_snapshot = ${tx.json(preview.recipient as never)}
        where id = ${id} and project_id = ${current.projectId}`
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
  })

  // Angebot versendet → beauftragt / abgelehnt (also Nachtrag: angeboten → beauftragt / abgelehnt).
  app.post('/api/v1/documents/:id/status', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(documentParam, request.params)
    const { status } = parse(documentStatusRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      const [d] = await tx<{ type: string; status: string }[]>`
        select d.type, d.status from document d join project p on p.id = d.project_id
        where d.id = ${id} and ${projectVisibility(tx, auth)} for update of d`
      if (!d) throw notFound('Das Dokument')
      if (!['quote', 'cost_estimate', 'change_order'].includes(d.type)) {
        throw new HttpError(409, 'Diesen Status gibt es nur bei Angeboten und Nachträgen.')
      }
      const allowed: Record<string, string[]> = {
        sent: ['finalized'],
        accepted: ['finalized', 'sent'],
        rejected: ['finalized', 'sent'],
      }
      if (!allowed[status]?.includes(d.status)) {
        throw new HttpError(
          409,
          d.status === 'draft'
            ? 'Bitte das Dokument zuerst fertigstellen.'
            : 'Dieser Statuswechsel ist nicht möglich.',
        )
      }
      await tx`update document set status = ${status},
                 sent_at = ${status === 'sent' ? tx`now()` : tx`sent_at`}
               where id = ${id}`
      if (d.type === 'change_order') {
        const meta = { sent: 'offered', accepted: 'accepted', rejected: 'rejected' }[status]
        await tx`
          update change_order_meta set status = ${meta},
                 offered_at = ${status === 'sent' ? tx`now()` : tx`offered_at`},
                 decided_at = ${status === 'sent' ? tx`decided_at` : tx`now()`},
                 decided_by_name = ${status === 'sent' ? tx`decided_by_name` : auth.displayName}
          where document_id = ${id}`
      }
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
  })
}
