import type { Tx } from '@opc/db'
import {
  billingQuantity,
  checkInvoiceRequirements,
  contributedQuantity,
  Decimal,
  type DeductedInvoice,
  type InvoiceKind,
  invoiceLegalNotes,
  isCumulativeInvoice,
  laborShareNote,
  ownMeasuredQuantity,
  type ProgressBillingMode,
  type TaxCategory,
  type TaxMode,
} from '@opc/domain'
import { einvoiceProblems } from '@opc/einvoice'
import type { DeductionSummary, DocumentDetail, FinalizeCheck } from '@opc/schemas'
import { einvoiceContext } from './einvoice.js'
import { reportBillingProblems } from './routes/report-billing.js'

/**
 * Rechnungsstellung: data access for deductions (Abschläge), Mengenfortschreibung from the
 * Leistungsaufmaß, checks before finalizing and legal notes. Calculations live in
 * packages/domain (billing.ts, document.ts).
 */

export interface BillingDoc {
  id: string
  projectId: string
  type: string
  invoiceKind: InvoiceKind | null
  progressBillingMode: ProgressBillingMode | null
  status: string
}

export async function billingDoc(tx: Tx, id: string): Promise<BillingDoc | undefined> {
  const [doc] = await tx<BillingDoc[]>`
    select id, project_id as "projectId", type, invoice_kind as "invoiceKind",
           progress_billing_mode as "progressBillingMode", status
    from document where id = ${id}`
  return doc
}

const cumulative = (doc: BillingDoc) =>
  doc.type === 'invoice' &&
  doc.invoiceKind !== null &&
  isCumulativeInvoice(doc.invoiceKind, doc.progressBillingMode)

/**
 * Drafts: the earlier invoices a cumulative invoice deducts are refreshed on every change, so the
 * draft always shows the current state. Finalized documents keep their rows (child guard).
 */
export async function refreshDeductions(tx: Tx, doc: BillingDoc): Promise<void> {
  if (doc.type !== 'invoice' || doc.status !== 'draft' || doc.invoiceKind === 'cancellation') return
  await tx`delete from document_deduction where document_id = ${doc.id}`
  if (!cumulative(doc)) return
  await tx`
    insert into document_deduction (tenant_id, document_id, deducted_document_id, net_cents, tax_cents, gross_cents)
    select d.tenant_id, ${doc.id}, d.id, d.net_total_cents, d.tax_total_cents, d.gross_total_cents
    from document d
    where d.project_id = ${doc.projectId} and d.type = 'invoice' and d.id <> ${doc.id}
      and d.invoice_kind in ('progress', 'partial')
      and d.finalized_at is not null and d.status <> 'cancelled'`
}

/**
 * Deducted invoices with their VAT per rate (for the domain) and as summary (for the API).
 * Drafts always show the current state (earlier invoices may have been cancelled meanwhile);
 * finalized documents show their stored rows.
 */
export async function loadDeductions(
  tx: Tx,
  documentId: string,
): Promise<{ inputs: DeductedInvoice[]; summaries: DeductionSummary[] }> {
  const doc = await billingDoc(tx, documentId)
  const live = doc?.status === 'draft' && doc.invoiceKind !== 'cancellation'
  if (live && !cumulative(doc)) return { inputs: [], summaries: [] }
  const rows = await tx<
    (Omit<DeductionSummary, 'netCents' | 'taxCents' | 'grossCents'> & {
      net: string
      tax: string
      gross: string
      sign: number
    })[]
  >`
    ${
      live
        ? tx`
      select d.id as "documentId", d.number, d.invoice_kind as "invoiceKind", d.progress_no as "progressNo",
             to_char(d.document_date, 'YYYY-MM-DD') as "documentDate", d.net_total_cents::text as net,
             d.tax_total_cents::text as tax, d.gross_total_cents::text as gross, 1 as sign
      from document d
      where d.project_id = ${doc.projectId} and d.type = 'invoice' and d.id <> ${documentId}
        and d.invoice_kind in ('progress', 'partial')
        and d.finalized_at is not null and d.status <> 'cancelled'`
        : tx`
      select dd.deducted_document_id as "documentId", d.number, d.invoice_kind as "invoiceKind",
             d.progress_no as "progressNo", to_char(d.document_date, 'YYYY-MM-DD') as "documentDate",
             dd.net_cents::text as net, dd.tax_cents::text as tax, dd.gross_cents::text as gross,
             case when o.invoice_kind = 'cancellation' then -1 else 1 end as sign
      from document_deduction dd
      join document d on d.id = dd.deducted_document_id
      join document o on o.id = dd.document_id
      where dd.document_id = ${documentId}`
    }
    order by "documentDate", number`
  if (!rows.length) return { inputs: [], summaries: [] }
  const lines = await tx<
    { documentId: string; category: TaxCategory; rate: string; net: string; tax: string }[]
  >`
    select document_id as "documentId", tax_category as category, rate_percent::text as rate,
           net_cents::text as net, tax_cents::text as tax
    from document_tax_line where document_id in ${tx(rows.map((r) => r.documentId))}`
  return {
    inputs: rows.map((r) => ({
      id: r.documentId,
      taxLines: lines
        .filter((l) => l.documentId === r.documentId)
        .map((l) => ({
          category: l.category,
          ratePercent: l.rate,
          netCents: BigInt(l.net) * BigInt(r.sign),
          taxCents: BigInt(l.tax) * BigInt(r.sign),
        })),
    })),
    summaries: rows.map(({ net, tax, gross, sign: _, ...r }) => ({
      ...r,
      netCents: Number(net),
      taxCents: Number(tax),
      grossCents: Number(gross),
    })),
  }
}

// ---- Mengenfortschreibung -------------------------------------------------------------------------

export interface ItemBilling {
  itemId: string
  /** Leistungsstand laut Leistungsaufmaß; null without measurement lines. */
  measured: string | null
  previouslyBilled: string
  /** Quantity to bill, rounded to the decimals of the unit; null without measurement. */
  quantity: string | null
  currentQuantity: string | null
  fromMeasurement: boolean
  /** Mehrmenge already in beauftragten Mehrmengen-Nachträgen (billed there, not here). */
  inChangeOrders: string
}

/**
 * Per priced position of an invoice: measured quantity (performance sheets) and quantity billed by
 * earlier finalized, not cancelled progress/partial invoices – both summed over the position's
 * origin (document_item_root), so Angebot, Auftrag and earlier Rechnungen count as one position.
 */
export async function itemBilling(tx: Tx, doc: BillingDoc): Promise<ItemBilling[]> {
  const items = await tx<
    {
      itemId: string
      root: string
      decimals: number | null
      quantity: string | null
      fromMeasurement: boolean
    }[]
  >`
    select i.id as "itemId", document_item_root(i.id) as root,
           (select u.decimals from unit u where u.id = i.unit_id)::int as decimals,
           trim_scale(i.quantity)::text as quantity, i.quantity_from_measurement as "fromMeasurement"
    from document_item i
    where i.document_id = ${doc.id} and i.position_type in ('item', 'lump_sum')`
  if (!items.length) return []
  const measured = await tx<{ root: string; quantity: string }[]>`
    select document_item_root(l.document_item_id) as root, sum(l.result_qty)::text as quantity
    from measurement_line l join measurement_sheet s on s.id = l.sheet_id
    where s.project_id = ${doc.projectId} and s.kind = 'performance' and l.document_item_id is not null
    group by 1`
  const earlier = await tx<
    {
      root: string
      quantity: string
      previouslyBilled: string | null
      kind: InvoiceKind
      mode: ProgressBillingMode | null
    }[]
  >`
    select document_item_root(i.id) as root, i.quantity::text as quantity,
           i.previously_billed_quantity::text as "previouslyBilled",
           d.invoice_kind as kind, d.progress_billing_mode as mode
    from document_item i join document d on d.id = i.document_id
    where d.project_id = ${doc.projectId} and d.type = 'invoice' and d.id <> ${doc.id}
      and d.invoice_kind in ('progress', 'partial')
      and d.finalized_at is not null and d.status <> 'cancelled'
      and i.position_type in ('item', 'lump_sum') and i.quantity is not null`
  // Mehrmengen-Nachträge (variance_of_item_id) that are beauftragt: their quantity is billed via
  // the Nachtrag, so the contract position bills only the rest of the measured quantity.
  const variances = await tx<{ root: string; quantity: string }[]>`
    select document_item_root(i.variance_of_item_id) as root, sum(i.quantity)::text as quantity
    from document_item i
    join document d on d.id = i.document_id
    join change_order_meta co on co.document_id = d.id
    left join change_order_item_decision dec on dec.document_item_id = i.id
    where d.project_id = ${doc.projectId} and d.type = 'change_order'
      and i.variance_of_item_id is not null and i.quantity is not null
      and (co.status = 'accepted' or (co.status = 'partially_accepted' and coalesce(dec.accepted, false)))
    group by 1`
  const measuredByRoot = new Map(measured.map((m) => [m.root, m.quantity]))
  const varianceByRoot = new Map(variances.map((v) => [v.root, v.quantity]))
  const billedByRoot = new Map<string, Decimal>()
  for (const e of earlier) {
    const add = contributedQuantity({
      quantity: e.quantity,
      previouslyBilled: e.previouslyBilled,
      cumulative: isCumulativeInvoice(e.kind, e.mode),
    })
    billedByRoot.set(e.root, (billedByRoot.get(e.root) ?? new Decimal(0)).plus(add))
  }
  const isCumulative = cumulative(doc)
  return items.map((item) => {
    const m = measuredByRoot.get(item.root) ?? null
    const previous = billedByRoot.get(item.root) ?? new Decimal(0)
    const inChangeOrders = varianceByRoot.get(item.root) ?? '0'
    const quantity =
      m === null
        ? null
        : billingQuantity({
            measured: m,
            previouslyBilled: previous,
            cumulative: isCumulative,
            inChangeOrders,
          })
            .toDecimalPlaces(item.decimals ?? 2, Decimal.ROUND_HALF_UP)
            .toString()
    return {
      itemId: item.itemId,
      inChangeOrders: new Decimal(inChangeOrders).toString(),
      measured: m === null ? null : ownMeasuredQuantity({ measured: m, inChangeOrders }).toString(),
      previouslyBilled: previous.toString(),
      quantity,
      currentQuantity: item.quantity,
      fromMeasurement: item.fromMeasurement,
    }
  })
}

/** „Mengen übernehmen“ for invoices: quantities from the Leistungsaufmaß (kumuliert − abgerechnet). */
export async function applyInvoiceMeasurements(tx: Tx, doc: BillingDoc): Promise<number> {
  const billing = await itemBilling(tx, doc)
  let applied = 0
  for (const b of billing) {
    await tx`
      update document_item set
        previously_billed_quantity = ${b.previouslyBilled},
        cumulative_quantity = ${b.measured},
        quantity = ${b.quantity ?? tx`quantity`},
        quantity_from_measurement = ${b.quantity === null ? tx`quantity_from_measurement` : true}
      where id = ${b.itemId}`
    if (b.quantity !== null) applied += 1
  }
  return applied
}

// ---- Checks before finalizing ----------------------------------------------------------------------

/** 12.5 → „12,5“ */
const germanQuantity = (value: Decimal) => value.toString().replace('.', ',')

type Issue = { field: string; message: string }

/** Pflichtangaben, Regel 12 (only contract and accepted change orders) and current quantities. */
export async function invoiceFinalizeCheck(
  tx: Tx,
  doc: BillingDoc,
  detail: DocumentDetail,
  issuerData: {
    street: string | null
    postalCode: string | null
    city: string | null
    taxNumber: string | null
    vatId: string | null
  },
): Promise<Omit<FinalizeCheck, 'numberPreview'>> {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const priced = detail.items.filter(
    (i) => i.positionType === 'item' || i.positionType === 'lump_sum',
  )
  for (const problem of checkInvoiceRequirements({
    issuer: { name: detail.issuer.name, ...issuerData },
    recipient: detail.recipient,
    recipientVatId: detail.recipient?.vatId ?? null,
    documentDate: detail.documentDate,
    serviceFrom: detail.serviceFrom,
    serviceTo: detail.serviceTo,
    pricedItemCount: priced.length,
    taxMode: detail.taxMode as TaxMode,
  })) {
    errors.push(problem)
  }
  // E-Rechnung (EN 16931, XRechnung): data the XML needs; KoSIT checks the file at Festschreiben.
  for (const problem of einvoiceProblems(detail, await einvoiceContext(tx, detail))) {
    errors.push(problem)
  }

  // Regel 12: positions from change orders only when accepted; free positions only with warning.
  for (const problem of await reportBillingProblems(tx, doc.id)) errors.push(problem)
  const origins = await tx<
    {
      itemId: string
      inContract: boolean
      openChangeOrder: number | null
      report: string | null
    }[]
  >`
    with recursive chain as (
      select i.id as item_id, i.id as cur, i.source_item_id as next, 0 as depth
      from document_item i
      where i.document_id = ${doc.id} and i.position_type in ('item', 'lump_sum')
      union all
      select c.item_id, s.id, s.source_item_id, c.depth + 1
      from chain c join document_item s on s.id = c.next where c.depth < 100
    )
    select c.item_id as "itemId",
           bool_or(d.type = 'order_confirmation' or (d.type = 'change_order' and (
             co.status = 'accepted' or (co.status = 'partially_accepted' and coalesce(dec.accepted, false))
           ))) as "inContract",
           max(case when d.type = 'change_order' and not (
             co.status = 'accepted' or (co.status = 'partially_accepted' and coalesce(dec.accepted, false))
           ) then co.number end)::int as "openChangeOrder",
           (select t.name || ' vom ' || to_char(r.report_date, 'DD.MM.YYYY')
            from document_item o join report r on r.id = o.source_report_id
            join report_template t on t.id = r.template_id where o.id = c.item_id) as report
    from chain c
    join document_item s on s.id = c.cur
    join document d on d.id = s.document_id
    left join change_order_meta co on co.document_id = d.id
    left join change_order_item_decision dec on dec.document_item_id = s.id
    group by c.item_id`
  const [contract] = await tx<{ exists: boolean }[]>`
    select exists (select 1 from document where project_id = ${doc.projectId}
                   and type = 'order_confirmation' and finalized_at is not null and status <> 'cancelled') as exists`
  const label = (itemId: string) => {
    const item = priced.find((i) => i.id === itemId)
    return `Position ${item?.oz ?? ''} „${item?.shortText ?? ''}“`.replace('  ', ' ')
  }
  const reports = new Set<string>()
  for (const origin of origins) {
    if (origin.openChangeOrder !== null) {
      errors.push({
        field: 'items',
        message: `${label(origin.itemId)} stammt aus Nachtrag N${String(origin.openChangeOrder).padStart(2, '0')}, der nicht beauftragt ist. Nicht beauftragte Nachträge sind nicht abrechenbar.`,
      })
    } else if (origin.report && doc.type === 'invoice') {
      reports.add(origin.report)
    } else if (!origin.inContract && contract?.exists && doc.type === 'invoice') {
      warnings.push({
        field: 'items',
        message: `${label(origin.itemId)} gehört weder zum Hauptauftrag noch zu einem beauftragten Nachtrag (freie Position).`,
      })
    }
  }

  // Stundenlohnarbeiten are billable only when agreed before they started (VOB/B § 2 Abs. 10).
  for (const report of reports) {
    warnings.push({
      field: 'items',
      message: `Positionen aus dem ${report}: Stundenlohnarbeiten sind nur abrechenbar, wenn sie vor Beginn vereinbart wurden. Bitte auch die Preise prüfen.`,
    })
  }

  // Quantities taken from the Leistungsaufmaß must still be current (another invoice may have
  // been finalized meanwhile, or lines were added).
  if (doc.type === 'invoice') {
    const billing = await itemBilling(tx, doc)
    // A Mehrmenge in a beauftragten Mehrmengen-Nachtrag is billed via the Nachtrag; a quantity
    // typed in by hand must not bill it again at the contract position.
    const isCumulative = cumulative(doc)
    for (const b of billing) {
      if (b.fromMeasurement || b.measured === null || b.currentQuantity === null) continue
      if (new Decimal(b.inChangeOrders).isZero()) continue
      const total = isCumulative
        ? new Decimal(b.currentQuantity)
        : new Decimal(b.previouslyBilled).plus(b.currentQuantity)
      if (total.gt(b.measured)) {
        errors.push({
          field: 'items',
          message: `${label(b.itemId)}: Abgerechnet wären ${germanQuantity(total)}, laut Aufmaß stehen der Position aber nur ${germanQuantity(new Decimal(b.measured))} zu – ${germanQuantity(new Decimal(b.inChangeOrders))} sind bereits im beauftragten Mehrmengen-Nachtrag und werden dort abgerechnet. Bitte „Mengen aus Aufmaß übernehmen“ ausführen oder die Menge korrigieren.`,
        })
      }
    }
    const outdated = billing.filter(
      (b) =>
        b.fromMeasurement &&
        b.quantity !== null &&
        b.currentQuantity !== null &&
        !new Decimal(b.quantity).eq(new Decimal(b.currentQuantity)),
    )
    if (outdated.length) {
      errors.push({
        field: 'items',
        message: `Die Mengen aus dem Leistungsaufmaß haben sich geändert (${outdated.length} Position${outdated.length === 1 ? '' : 'en'}). Bitte „Mengen aus Aufmaß übernehmen“ erneut ausführen.`,
      })
    }
  }
  // Positions without a price (e.g. Leistungen/Material/Geräte taken over from a Regiebericht at
  // 0 €) would be billed for free without anyone noticing.
  const unpriced = priced.filter(
    (i) =>
      (i.unitPriceCents ?? 0) === 0 && (i.quantity === null || !new Decimal(i.quantity).isZero()),
  )
  if (unpriced.length) {
    const shown = unpriced.slice(0, 5).map((i) => label(i.id))
    const more =
      unpriced.length > shown.length ? ` und ${unpriced.length - shown.length} weitere` : ''
    warnings.push({
      field: 'items',
      message: `${unpriced.length} Position${unpriced.length === 1 ? ' hat' : 'en haben'} keinen Preis (0,00 €): ${shown.join(', ')}${more}. Bitte Preise prüfen, sonst werden sie kostenlos berechnet.`,
    })
  }
  if (detail.totals.grossCents === 0 && detail.totals.deductions.length === 0) {
    warnings.push({ field: 'items', message: 'Der Rechnungsbetrag ist 0,00 €.' })
  }
  return { errors, warnings }
}

// ---- Pflichthinweise ---------------------------------------------------------------------------------

export function legalNotesOf(detail: DocumentDetail): string[] {
  const laborShare =
    detail.showLaborShare && detail.type !== 'delivery_note'
      ? {
          netCents: BigInt(detail.totals.laborShare.netCents),
          grossCents: BigInt(detail.totals.laborShare.grossCents),
        }
      : null
  if (detail.type !== 'invoice' && detail.type !== 'credit_note') {
    const note = laborShareNote(laborShare)
    return note ? [note] : []
  }
  return invoiceLegalNotes({
    laborShare,
    kind: (detail.invoiceKind ?? 'standard') as InvoiceKind,
    taxMode: detail.taxMode as TaxMode,
    recipientIsPrivate: detail.recipient?.private ?? false,
    documentDate: detail.documentDate,
    paymentDueDays: detail.paymentDueDays,
    cashDiscount:
      detail.cashDiscountPercent && detail.cashDiscountDays !== null
        ? {
            percent: detail.cashDiscountPercent,
            days: detail.cashDiscountDays,
            amountCents: BigInt(detail.totals.cashDiscountCents),
          }
        : null,
    progressNo: detail.progressNo,
    cancels:
      detail.cancels?.number && detail.cancelReason
        ? { number: detail.cancels.number, reason: detail.cancelReason }
        : null,
  })
}
