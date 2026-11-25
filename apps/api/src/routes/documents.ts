import { createHash } from 'node:crypto'
import type { Tx } from '@easybau/db'
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
} from '@easybau/domain'
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
  type EinvoiceFormat,
  type EvidenceRef,
  finalizeRequest,
  moveItemRequest,
  PRICED_POSITION_TYPES,
  type TaxRateSummary,
  type UnitSummary,
  updateDocumentRequest,
  updateItemRequest,
} from '@easybau/schemas'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { archiveSummary } from '../artifacts.js'
import { billingDoc, legalNotesOf, loadDeductions, refreshDeductions } from '../billing.js'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requirePermission,
  requireVisibleProject,
  type Services,
  servicesOf,
} from '../context.js'
import { einvoiceSummary } from '../einvoice.js'
import { checkIfMatch, etagOf, HttpError, notFound, parse } from '../http.js'
import { checkEvidence, resolveEvidence } from './change-orders.js'
import { restrictedContact, usableContact } from './contacts.js'
import { documentSettings, laborShareDefault } from './document-settings.js'
import { finalizeInvoice } from './invoices.js'
import { companyValues, loadLetterhead } from './letterhead.js'
import { notify, projectMembersExcept } from './notifications.js'
import { archiveDocumentPdf } from './pdf.js'
import { loadReceivable, todayOf } from './receivables.js'

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
  cumulativeQuantity: string | null
  previouslyBilledQuantity: string | null
  imageFileId: string | null
  imageName: string | null
  catalogItemId: string | null
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
           calc_mode as "calcMode", trim_scale(cumulative_quantity)::text as "cumulativeQuantity",
           trim_scale(previously_billed_quantity)::text as "previouslyBilledQuantity",
           image_file_id as "imageFileId", catalog_item_id as "catalogItemId",
           (select f.filename from file f where f.id = image_file_id) as "imageName"
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
/** Document fields that influence the totals. */
interface TotalsSettings {
  taxMode: string
  discountPercent: string | null
  retentionPercent: string | null
  constructionLevyPercent: string | null
  cashDiscountPercent: string | null
}

const TOTALS_SETTINGS = (tx: Tx) => tx`
  tax_mode as "taxMode", discount_percent::text as "discountPercent",
  retention_percent::text as "retentionPercent",
  construction_levy_percent::text as "constructionLevyPercent",
  cash_discount_percent::text as "cashDiscountPercent"`

function totalsInput(doc: TotalsSettings) {
  return {
    taxMode: doc.taxMode as 'standard',
    ...(doc.discountPercent ? { discountPercent: doc.discountPercent } : {}),
    ...(doc.retentionPercent ? { retentionPercent: doc.retentionPercent } : {}),
    ...(doc.constructionLevyPercent
      ? { constructionLevyPercent: doc.constructionLevyPercent }
      : {}),
    ...(doc.cashDiscountPercent ? { cashDiscountPercent: doc.cashDiscountPercent } : {}),
  }
}

export async function recalculate(tx: Tx, documentId: string): Promise<void> {
  const [doc] = await tx<(TotalsSettings & { invoiceKind: string | null })[]>`
    select ${TOTALS_SETTINGS(tx)}, invoice_kind as "invoiceKind" from document where id = ${documentId}`
  if (!doc) return
  // A Stornorechnung mirrors the cancelled invoice exactly; it is never recalculated.
  if (doc.invoiceKind === 'cancellation') return
  const billing = await billingDoc(tx, documentId)
  if (billing) await refreshDeductions(tx, billing)
  const { inputs: deductions } = await loadDeductions(tx, documentId)
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
    totals = calculateDocumentTotals({ lines, ...totalsInput(doc), deductions })
  } catch (error) {
    calculationError(error)
  }
  await tx`
    update document set net_total_cents = ${totals.netCents.toString()},
                        tax_total_cents = ${totals.taxCents.toString()},
                        gross_total_cents = ${totals.grossCents.toString()},
                        payable_cents = ${totals.payableCents.toString()},
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
  doc: TotalsSettings,
  deductions: Awaited<ReturnType<typeof loadDeductions>>,
): DocumentTotals {
  const totals = calculateDocumentTotals({
    ...totalsInput(doc),
    deductions: deductions.inputs,
    lines: rows.map((row) => {
      const lines = costs.get(row.id)
      // Lohnkostenanteil (§ 35a) only from positions with Kalkulation.
      const labor = lines?.length
        ? ((priceOf(row, lines) as ReturnType<typeof calculateItem> | null)?.laborShareCents ?? 0n)
        : 0n
      return {
        id: row.id,
        parentId: row.parentId,
        positionType: row.positionType as PositionType,
        ...(row.totalCents === null ? {} : { totalCents: BigInt(row.totalCents) }),
        ...(row.taxRatePercent ? { taxRatePercent: row.taxRatePercent } : {}),
        ...(row.taxCategory ? { taxCategory: row.taxCategory } : {}),
        ...(labor ? { laborShareCents: labor } : {}),
      }
    }),
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
    performance: {
      netCents: Number(totals.performance.netCents),
      taxCents: Number(totals.performance.taxCents),
      grossCents: Number(totals.performance.grossCents),
    },
    deductions: deductions.summaries,
    retentionCents: Number(totals.retentionCents),
    constructionLevyCents: Number(totals.constructionLevyCents),
    payableCents: Number(totals.payableCents),
    cashDiscountCents: Number(totals.cashDiscountCents),
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
      itemsNetCents: Number(t.itemsNetCents),
      discountCents: Number(t.discountCents),
      deductedNetCents: Number(t.deductedNetCents),
    })),
    titleSubtotals: Object.fromEntries(
      [...totals.titleSubtotals].map(([id, cents]) => [id, Number(cents)]),
    ),
    costCents: Number(costCents),
    marginCents: Number(totals.netCents - costCents),
    laborHours: roundTo(new Decimal(laborHundredths.toString()).div(100), 2),
    uncalculatedCount,
    laborShare: {
      netCents: Number(totals.laborShare.netCents),
      grossCents: Number(totals.laborShare.grossCents),
    },
  }
}

// ---- Letter header: Firma and Empfänger ---------------------------------------------------------

type Issuer = DocumentDetail['issuer']

export async function liveIssuer(tx: Tx): Promise<Issuer> {
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
      ibanEnc: Buffer | null
      bic: string | null
      countryCode: string
    }[]
  >`
    select name, street, postal_code as "postalCode", city, email, phone, website, vat_id as "vatId",
           tax_number as "taxNumber", register_court as "registerCourt", register_number as "registerNumber",
           manager_title as "managerTitle", manager_name as "managerName", iban_enc as "ibanEnc", bic,
           country_code as "countryCode"
    from tenant where id = current_tenant_id()`
  if (!t) return { name: '', lines: [], contact: [], legal: [] }
  const cipher = servicesOf(tx)?.cipher
  const iban =
    t.ibanEnc && cipher ? cipher.decrypt(t.ibanEnc).replace(/\s+/g, '').toUpperCase() : null
  const place = [t.postalCode, t.city].filter(Boolean).join(' ')
  return {
    // Briefpapier and its placeholder values; frozen with the document (rule 4).
    letterhead: await loadLetterhead(tx),
    values: (await companyValues(tx)) as Record<string, string | null>,
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
    // Structured data for the e-invoice (EN 16931), frozen with the document (rule 4).
    address: {
      street: t.street,
      streetExtra: null,
      postalCode: t.postalCode,
      city: t.city,
      countryCode: t.countryCode.trim().toUpperCase(),
    },
    einvoice: {
      vatId: t.vatId,
      taxNumber: t.taxNumber,
      email: t.email,
      phone: t.phone,
      contactName: t.managerName,
      iban,
      bic: t.bic,
    },
  }
}

/** Empfänger: billing address (Rechnungsempfänger) if present, otherwise the main address. */
export async function liveRecipient(
  tx: Tx,
  contactId: string | null,
  contactPersonId: string | null = null,
): Promise<DocumentDetail['recipient']> {
  if (!contactId) return null
  const [c] = await tx<
    {
      name: string
      private: boolean
      vatId: string | null
      customerNumber: string | null
      buyerReference: string | null
      einvoiceEmail: string | null
      einvoiceFormat: EinvoiceFormat | null
    }[]
  >`
    select display_name as name, kind = 'person' as private, vat_id as "vatId", number as "customerNumber",
           buyer_reference as "buyerReference", einvoice_email as "einvoiceEmail",
           einvoice_format as "einvoiceFormat"
    from contact where id = ${contactId}`
  if (!c) return null
  // Ansprechpartner: „z. Hd. …“ as the first line under the name (DIN 5008).
  const [person] = contactPersonId
    ? await tx<{ name: string }[]>`
        select concat_ws(' ', nullif(salutation, ''), nullif(title, ''), first_name, last_name) as name
        from contact where id = ${contactPersonId} and kind = 'person'`
    : []
  const attention = person?.name ? [`z. Hd. ${person.name}`] : []
  const extra = {
    private: c.private,
    vatId: c.vatId,
    // E-Rechnung: Kundennummer, Leitweg-ID, address and format (frozen with the document).
    customerNumber: c.customerNumber,
    buyerReference: c.buyerReference,
    einvoiceEmail: c.einvoiceEmail,
    einvoiceFormat: c.einvoiceFormat,
  }
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
  if (!a) return { name: c.name, lines: attention, ...extra }
  const block =
    a.recipientBlock
      ?.split('\n')
      .map((l) => l.trim())
      .filter(Boolean) ?? []
  return {
    name: block[0] ?? c.name,
    lines: [
      ...attention,
      ...block.slice(1),
      a.street,
      a.streetExtra,
      [a.postalCode, a.city].filter(Boolean).join(' ') || null,
      a.countryCode !== 'DE' ? a.countryCode : null,
    ].filter((v): v is string => !!v),
    ...extra,
    address: {
      street: a.street,
      streetExtra: a.streetExtra,
      postalCode: a.postalCode,
      city: a.city,
      countryCode: a.countryCode.trim().toUpperCase(),
    },
  }
}

// ---- Loading ------------------------------------------------------------------------------------

type DocumentRow = Omit<
  DocumentDetail,
  | 'items'
  | 'totals'
  | 'issuer'
  | 'recipient'
  | 'changeOrderInfo'
  | 'canConvertToChangeOrder'
  | 'legalNotes'
> &
  TotalsSettings & {
    updatedRaw: Date
    contactId: string | null
    issuerSnapshot: Issuer | null
    recipientSnapshot: DocumentDetail['recipient'] | null
    storedNotes: string[] | null
    hasVersions: boolean
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
           case when cp.id is null then null else json_build_object('id', cp.id, 'displayName', cp.display_name) end as "contactPerson",
           d.contact_id as "contactId",
           d.place_of_performance as "placeOfPerformance",
           ${DATE(tx, 'd.service_from')} as "serviceFrom", ${DATE(tx, 'd.service_to')} as "serviceTo",
           ${DATE(tx, 'd.valid_until')} as "validUntil",
           d.intro_text as "introText", d.closing_text as "closingText", d.payment_due_days as "paymentDueDays",
           trim_scale(d.discount_percent)::text as "discountPercent", d.tax_mode as "taxMode",
           d.source_document_id as "sourceDocumentId",
           d.issuer_snapshot as "issuerSnapshot", d.recipient_snapshot as "recipientSnapshot",
           trim_scale(d.cash_discount_percent)::text as "cashDiscountPercent", d.cash_discount_days as "cashDiscountDays",
           trim_scale(d.retention_percent)::text as "retentionPercent",
           trim_scale(d.construction_levy_percent)::text as "constructionLevyPercent",
           d.progress_billing_mode as "progressBillingMode", ${DATE(tx, 'd.due_date')} as "dueDate",
           d.cancel_reason as "cancelReason", d.legal_notes as "storedNotes",
           d.show_labor_share as "showLaborShare", d.version,
           d.previous_version_id is not null or exists (
             select 1 from document v where v.previous_version_id = d.id) as "hasVersions"
    from ${fromDocuments(tx)}
    left join contact c on c.id = d.contact_id
    left join contact cp on cp.id = d.contact_person_id
    where d.id = ${id} and ${projectVisibility(tx, auth)}`
  if (!row) return null
  const rows = await loadItems(tx, id)
  const costs = await loadCostLines(tx, id)
  const {
    updatedRaw,
    contactId,
    issuerSnapshot,
    recipientSnapshot,
    storedNotes,
    hasVersions,
    ...doc
  } = row
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
      cumulativeQuantity: r.cumulativeQuantity,
      previouslyBilledQuantity: r.previouslyBilledQuantity,
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
      image: r.imageFileId
        ? {
            fileId: r.imageFileId,
            name: r.imageName ?? '',
            url: `/api/v1/files/${r.imageFileId}/content`,
          }
        : null,
      catalogItemId: r.catalogItemId,
    }
  })
  const [info] = await tx<
    {
      contractId: string
      contractLabel: string
      reason: string | null
      evidence: EvidenceRef[]
    }[]
  >`
    select m.contract_document_id as "contractId",
           coalesce(c.number, 'Auftragsbestätigung (Entwurf)') as "contractLabel", m.reason, m.evidence
    from change_order_meta m join document c on c.id = m.contract_document_id
    where m.document_id = ${id}`
  const canConvert =
    doc.status === 'draft' &&
    (doc.type === 'change_order' ||
      (doc.type === 'quote' && (await projectFacts(tx, doc.projectId)).hasContract))
  const detail: DocumentDetail = {
    ...doc,
    issuer: issuerSnapshot ?? (await liveIssuer(tx)),
    recipient: recipientSnapshot ?? (await liveRecipient(tx, contactId, doc.contactPerson?.id)),
    changeOrderInfo: info
      ? {
          ...info,
          evidence: await resolveEvidence(tx, info.evidence),
          acceptedItemIds:
            doc.status === 'partially_accepted'
              ? (
                  await tx<{ id: string }[]>`
                    select i.id from document_item i
                    join change_order_item_decision dec on dec.document_item_id = i.id
                    where i.document_id = ${id} and dec.accepted order by i.sort, i.id`
                ).map((r) => r.id)
              : null,
        }
      : null,
    canConvertToChangeOrder: canConvert,
    items,
    totals: totalsOf(rows, costs, doc, await loadDeductions(tx, id)),
    legalNotes: [],
    versions: hasVersions ? await versionsOf(tx, id) : [],
    einvoice: doc.status === 'draft' ? null : await einvoiceSummary(tx, id),
    archive: doc.status === 'draft' ? null : await archiveSummary(tx, id),
  }
  // Finalized: the frozen notes; drafts: a live preview.
  detail.legalNotes = storedNotes ?? (doc.status === 'draft' ? legalNotesOf(detail) : [])
  detail.receivable = await loadReceivable(tx, detail, todayOf(tx))
  return { ...detail, etag: etagOf(updatedRaw) }
}

/** All versions of an offer (Angebotsversionen, P2.12), oldest first. */
async function versionsOf(tx: Tx, id: string): Promise<DocumentDetail['versions']> {
  return tx<DocumentDetail['versions']>`
    with recursive up as (
      select id, previous_version_id from document where id = ${id}
      union all
      select d.id, d.previous_version_id from document d join up on d.id = up.previous_version_id
    ), chain as (
      select d.id, d.version, d.number, d.status from document d
      where d.id = (select id from up where previous_version_id is null)
      union all
      select d.id, d.version, d.number, d.status from document d join chain on d.previous_version_id = chain.id
    )
    select id, version, number, status from chain order by version`
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

export async function createDocument(
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
    // Angebotsversionen: an older version is replaced once a newer one has been finalized.
    const [newer] = await tx<{ version: number; number: string | null }[]>`
      with recursive later as (
        select id, version, number, status from document where previous_version_id = ${source.id}
        union all
        select d.id, d.version, d.number, d.status from document d join later on d.previous_version_id = later.id
      )
      select version, number from later where status <> 'draft' order by version desc limit 1`
    if (newer) {
      throw new HttpError(
        409,
        `Dieses Angebot ist durch Version ${newer.version}${newer.number ? ` (${newer.number})` : ''} ersetzt. Bitte das Folgedokument aus der neuesten Version erstellen.`,
      )
    }
  }

  const contactId = source ? source.contactId : project.customerId
  // DSGVO: no new documents for a blocked or erased contact (Art. 18).
  if (contactId && !(await usableContact(tx, contactId))) throw restrictedContact()
  const [contact] = contactId
    ? await tx<
        {
          taxMode: string
          kind: string
          dueDays: number | null
          discountPercent: string | null
          discountDays: number | null
        }[]
      >`
        select c.tax_mode as "taxMode", c.kind, pt.due_days as "dueDays",
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
  const defaults = await documentSettings(tx)
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
    progress_billing_mode: input.invoiceKind === 'progress' ? defaults.progressBillingMode : null,
    show_labor_share: laborShareDefault(defaults, input.type, contact?.kind ?? null),
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
    const evidence = await checkEvidence(tx, projectId, input.evidence ?? [])
    // The latest order confirmation is the main contract (Hauptauftrag).
    await tx`
      insert into change_order_meta (document_id, tenant_id, contract_document_id, number, basis, reason, evidence)
      select ${documentId}, ${auth.tenantId}, c.id,
             (select coalesce(max(m.number), 0) + 1 from change_order_meta m where m.contract_document_id = c.id),
             ${input.basis ?? 'additional_work'}, ${input.reason ?? null}, ${tx.json(evidence as never)}
      from document c
      where c.project_id = ${projectId} and c.type = 'order_confirmation' and c.status <> 'cancelled'
      order by c.created_at desc limit 1`
  }

  if (source) await copyItems(tx, source.id, documentId)
  await recalculate(tx, documentId)
  return documentId
}

/** Copies the outline of a document (Zusammenhängend erstellen), keeping the reference per item. */
export async function copyItems(tx: Tx, fromId: string, toId: string) {
  const order = outline(await loadItems(tx, fromId))
  const newIds = new Map<string, string>()
  for (const { row } of order) {
    const [created] = await tx<{ id: string }[]>`
      insert into document_item (tenant_id, document_id, parent_id, sort, position_type, oz, quantity, unit_id,
                                 unit_symbol, unit_unece_code, short_text, long_text, show_long_text, calc_mode,
                                 unit_price_cents, discount_percent, total_cents, tax_rate_percent, tax_category,
                                 catalog_item_id, source_item_id, image_file_id, source_report_id)
      select tenant_id, ${toId}, ${row.parentId ? (newIds.get(row.parentId) ?? null) : null}, sort, position_type, oz,
             quantity, unit_id, unit_symbol, unit_unece_code, short_text, long_text, show_long_text, calc_mode,
             unit_price_cents, discount_percent, total_cents, tax_rate_percent, tax_category,
             catalog_item_id, id, image_file_id, source_report_id
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

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Bild-Position: an image of the Ablage of the document's project. */
async function imageFileOf(tx: Tx, documentId: string, fileId: string | null | undefined) {
  const [file] = fileId
    ? await tx<{ mime: string }[]>`
        select f.mime_type as mime from file f join document d on d.project_id = f.project_id
        where f.id = ${fileId} and d.id = ${documentId}`
    : []
  if (!file) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      imageFileId: 'Das Bild gehört nicht zur Ablage dieses Projekts.',
    })
  }
  if (!IMAGE_TYPES.includes(file.mime)) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      imageFileId: 'Als Bild sind PNG, JPEG, WebP und GIF möglich.',
    })
  }
  return fileId
}

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
      if (input.contactId && !(await usableContact(tx, input.contactId))) {
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
        contactPersonId: 'contact_person_id',
        introText: 'intro_text',
        closingText: 'closing_text',
        paymentDueDays: 'payment_due_days',
        discountPercent: 'discount_percent',
        taxMode: 'tax_mode',
        validUntil: 'valid_until',
        cashDiscountPercent: 'cash_discount_percent',
        cashDiscountDays: 'cash_discount_days',
        retentionPercent: 'retention_percent',
        constructionLevyPercent: 'construction_levy_percent',
        progressBillingMode: 'progress_billing_mode',
        showLaborShare: 'show_labor_share',
      }
      // Ansprechpartner: a person linked to the (new) recipient organization; another recipient
      // drops a person who is not linked to it.
      const [links] = await tx<{ contactId: string | null; personId: string | null }[]>`
        select contact_id as "contactId", contact_person_id as "personId" from document where id = ${id}`
      const recipientId =
        input.contactId !== undefined ? input.contactId : (links?.contactId ?? null)
      const personId =
        input.contactPersonId !== undefined ? input.contactPersonId : (links?.personId ?? null)
      if (personId) {
        const [linked] = recipientId
          ? await tx`
              select 1 from contact_link l join contact p on p.id = l.person_id
              where l.organization_id = ${recipientId} and l.person_id = ${personId}
                and p.blocked_at is null and p.erased_at is null`
          : []
        if (!linked) {
          if (input.contactPersonId) {
            throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
              contactPersonId: 'Die Person ist kein Ansprechpartner dieses Empfängers.',
            })
          }
          input.contactPersonId = null
        }
      }
      const columns: Record<string, unknown> = {}
      for (const [key, column] of Object.entries(map)) {
        const value = input[key as keyof typeof input]
        if (value !== undefined) columns[column] = value
      }
      // Another recipient brings the default of „Lohnkostenanteil ausweisen“ (person/organization).
      if (input.contactId !== undefined && input.showLaborShare === undefined) {
        const [row] = await tx<{ type: string; kind: string | null; changed: boolean }[]>`
          select d.type, (select kind from contact where id = ${input.contactId}) as kind,
                 d.contact_id is distinct from ${input.contactId}::uuid as changed
          from document d where d.id = ${id}`
        if (row?.changed) {
          columns.show_labor_share = laborShareDefault(
            await documentSettings(tx),
            row.type,
            row.kind,
          )
        }
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
          image_file_id:
            input.positionType === 'image' ? await imageFileOf(tx, id, input.imageFileId) : null,
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
      const [d] = await tx<
        { type: string; contactId: string | null; documentDate: string; version: number }[]
      >`
        select type, contact_id as "contactId", to_char(document_date, 'YYYY-MM-DD') as "documentDate", version
        from document where id = ${id}`
      if (!d) throw notFound('Das Dokument')
      if (d.type === 'invoice' || d.type === 'credit_note') {
        await finalizeInvoice(tx, auth, id, parse(finalizeRequest, request.body ?? {}))
        return loadDocument(tx, auth, id)
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
      } else if (d.version > 1) {
        // Angebotsversion: number of version 1 with "-V2", "-V3" … (no new number from the sequence).
        const [root] = await tx<{ number: string | null }[]>`
          with recursive up as (
            select id, previous_version_id, number from document where id = ${id}
            union all
            select p.id, p.previous_version_id, p.number from document p join up on p.id = up.previous_version_id
          )
          select number from up where previous_version_id is null`
        if (!root?.number) throw new HttpError(409, 'Die erste Version hat noch keine Nummer.')
        number = `${root.number}-V${d.version}`
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
               recipient_snapshot = ${tx.json(preview.recipient as never)},
               legal_notes = ${tx.json(legalNotesOf(preview))}
        where id = ${id} and project_id = ${current.projectId}`
      return loadDocument(tx, auth, id)
    })
    // Archive the PDF/A original right away (best effort, a later download archives as well).
    await archiveDocumentPdf(services, auth, id).catch((error: unknown) =>
      request.log.warn({ err: error }, 'PDF archiving after finalize failed'),
    )
    return sendDocument(reply, doc)
  })

  // Angebot versendet → beauftragt / abgelehnt (also Nachtrag: angeboten → beauftragt / abgelehnt).
  app.post('/api/v1/documents/:id/status', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(documentParam, request.params)
    const { status, acceptedItemIds } = parse(documentStatusRequest, request.body)
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
        partially_accepted: ['finalized', 'sent'],
        rejected: ['finalized', 'sent'],
      }
      if (status === 'partially_accepted' && d.type !== 'change_order') {
        throw new HttpError(409, 'Teilweise beauftragen lassen sich nur Nachträge.')
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
      if (status === 'partially_accepted') {
        // Teilbeauftragung: one decision per priced position; only accepted ones count for the
        // Vertragssumme and may be billed (Regel 12).
        const priced = await tx<{ id: string }[]>`
          select id from document_item
          where document_id = ${id} and position_type in ('item', 'lump_sum')`
        const ids = new Set(priced.map((p) => p.id))
        const chosen = new Set(acceptedItemIds)
        if ([...chosen].some((itemId) => !ids.has(itemId))) {
          throw new HttpError(400, 'Eine ausgewählte Position gehört nicht zu diesem Nachtrag.', {
            acceptedItemIds: 'Nur Positionen dieses Nachtrags auswählen.',
          })
        }
        if (chosen.size === ids.size) {
          throw new HttpError(
            409,
            'Alle Positionen sind ausgewählt – bitte „Beauftragt“ verwenden.',
            { acceptedItemIds: 'Mindestens eine Position bleibt unbeauftragt.' },
          )
        }
        for (const itemId of ids) {
          await tx`
            insert into change_order_item_decision (tenant_id, document_item_id, accepted)
            values (${auth.tenantId}, ${itemId}, ${chosen.has(itemId)})
            on conflict (document_item_id) do update set accepted = excluded.accepted`
        }
      }
      if (d.type === 'change_order') {
        const meta = {
          sent: 'offered',
          accepted: 'accepted',
          partially_accepted: 'partially_accepted',
          rejected: 'rejected',
        }[status]
        await tx`
          update change_order_meta set status = ${meta},
                 offered_at = ${status === 'sent' ? tx`now()` : tx`offered_at`},
                 decided_at = ${status === 'sent' ? tx`decided_at` : tx`now()`},
                 decided_by_name = ${status === 'sent' ? tx`decided_by_name` : auth.displayName}
          where document_id = ${id}`
        if (status !== 'sent') {
          // Benachrichtigung: Nachtrag beauftragt oder abgelehnt (P2.8).
          const [co] = await tx<
            {
              number: number
              projectId: string
              subject: string | null
              createdBy: string | null
            }[]
          >`
            select m.number, d.project_id as "projectId", d.subject, d.created_by as "createdBy"
            from change_order_meta m join document d on d.id = m.document_id where m.document_id = ${id}`
          if (co) {
            const members = await projectMembersExcept(tx, co.projectId, auth.userId)
            await notify(
              tx,
              auth.tenantId,
              [...members, ...(co.createdBy && co.createdBy !== auth.userId ? [co.createdBy] : [])],
              {
                kind: 'change_order_decided',
                refId: id,
                title: `Nachtrag N${String(co.number).padStart(2, '0')} ${
                  status === 'accepted'
                    ? 'beauftragt'
                    : status === 'partially_accepted'
                      ? 'teilweise beauftragt'
                      : 'abgelehnt'
                }`,
                body: co.subject,
                route: `/dokumente/${id}`,
              },
            )
          }
        }
      }
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
  })
}
