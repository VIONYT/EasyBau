import { Readable } from 'node:stream'
import type { Tx } from '@opc/db'
import { allocationTax, type CostType } from '@opc/domain'
import {
  customerAccount,
  datevBookingBatch,
  datevBookings,
  type ExportAdjustment,
  type ExportIncoming,
  type ExportIncomingPayment,
  type ExportInvoice,
  type ExportPayment,
  encodeWindows1252,
  fiscalYearStart,
  type GobdTable,
  germanAmount,
  germanDate,
  gobdIndexXml,
  gobdTableCsv,
  incomingBookings,
  type ZipEntry,
  zipStream,
} from '@opc/exports'
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { openArtifact } from '../artifacts.js'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, parse } from '../http.js'
import { audit } from './auth-common.js'
import { archiveDocumentPdf } from './pdf.js'
import { DATEV_DEFAULTS, datevSettings } from './settings.js'

const periodQuery = z
  .object({
    from: z.iso.date('Datum im Format JJJJ-MM-TT erwartet.'),
    to: z.iso.date('Datum im Format JJJJ-MM-TT erwartet.'),
    /** DATEV: ZIP with the document originals (Belege) next to the Buchungsstapel. */
    belege: z.enum(['true', 'false']).default('false'),
  })
  .refine((p) => p.to >= p.from, {
    path: ['to'],
    message: 'Das Ende darf nicht vor dem Beginn liegen.',
  })

/** Finalized invoices and credit notes of a period; credit notes count negative. */
async function invoicesOf(tx: Tx, from: string, to: string) {
  return tx<
    {
      id: string
      number: string
      type: 'invoice' | 'credit_note'
      invoiceKind: string | null
      date: string
      serviceFrom: string | null
      serviceTo: string | null
      customerNumber: string | null
      customerName: string
      net: string
      tax: string
      gross: string
      status: string
      finalizedAt: string
      cancelsNumber: string | null
      sign: number
    }[]
  >`
    select d.id, d.number, d.type, d.invoice_kind as "invoiceKind", to_char(d.document_date, 'YYYY-MM-DD') as date,
           to_char(d.service_from, 'YYYY-MM-DD') as "serviceFrom", to_char(d.service_to, 'YYYY-MM-DD') as "serviceTo",
           c.number as "customerNumber",
           coalesce(d.recipient_snapshot ->> 'name', c.display_name, '') as "customerName",
           d.net_total_cents::text as net, d.tax_total_cents::text as tax, d.gross_total_cents::text as gross,
           d.status, to_char(d.finalized_at, 'YYYY-MM-DD') as "finalizedAt", x.number as "cancelsNumber",
           case when d.type = 'credit_note' then -1 else 1 end as sign
    from document d
    left join contact c on c.id = d.contact_id
    left join document x on x.id = d.cancels_document_id
    where d.type in ('invoice', 'credit_note') and d.finalized_at is not null
      and d.document_date between ${from}::date and ${to}::date
    order by d.document_date, d.number`
}

function sendFile(
  reply: FastifyReply,
  filename: string,
  contentType: string,
  body: Buffer | Readable,
) {
  return reply
    .header('content-type', contentType)
    .header('content-disposition', `attachment; filename="${filename}"`)
    .header('cache-control', 'no-store')
    .send(body)
}

const INCOMING_STATUS: Record<string, string> = {
  review: 'in Prüfung',
  confirmed: 'geprüft',
  cancelled: 'storniert',
  discarded: 'verworfen',
}

const isoNow = () => new Date().toISOString().slice(0, 10)

// ---- Belege: archived originals (ADR 0008) for exports --------------------------------------------

interface BelegRow {
  documentId: string | null
  number: string
  kind:
    | 'pdf'
    | 'zugferd_pdf'
    | 'zugferd_xml'
    | 'xrechnung_xml'
    | 'validation_report'
    | 'incoming_original'
  format: string | null
  /** Eingangsrechnung: supplier, original file name and id (for a unique file name). */
  supplier?: string | null
  filename?: string
  incomingId?: string
  key: string
  sha256: string
  sizeBytes: string
  lockedUntil: string
  archivedAt: string | null
}

const BELEG_KIND: Record<BelegRow['kind'], string> = {
  pdf: 'Beleg PDF/A',
  zugferd_pdf: 'Rechnung PDF/A-3 mit ZUGFeRD',
  zugferd_xml: 'E-Rechnung ZUGFeRD (CII)',
  xrechnung_xml: 'E-Rechnung XRechnung',
  validation_report: 'Prüfbericht KoSIT',
  incoming_original: 'Eingangsrechnung (Original wie empfangen)',
}

/** File name inside the export, e.g. R-00101.pdf, R-00101_zugferd.xml, R-00101_pruefbericht_zugferd.xml. */
function belegFile(row: BelegRow): string {
  if (row.kind === 'incoming_original') {
    const ext = /\.([a-z0-9]{1,5})$/i.exec(row.filename ?? '')?.[1]?.toLowerCase() ?? 'bin'
    const name =
      [row.supplier, row.number]
        .filter(Boolean)
        .join('_')
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .slice(0, 80) || 'Eingangsrechnung'
    return `eingang/${name}_${(row.incomingId ?? '').slice(0, 8)}.${ext}`
  }
  const number = row.number.replace(/[^A-Za-z0-9._-]+/g, '_')
  switch (row.kind) {
    case 'pdf':
    case 'zugferd_pdf':
      return `${number}.pdf`
    case 'zugferd_xml':
      return `${number}_zugferd.xml`
    case 'xrechnung_xml':
      return `${number}_${row.format === 'xrechnung_cii' ? 'xrechnung_cii' : 'xrechnung'}.xml`
    case 'validation_report':
      return `${number}_pruefbericht_${row.format ?? 'einvoice'}.xml`
  }
}

/** Archived originals of finalized documents (PDF, e-invoice XML, KoSIT report). */
async function belegeOf(tx: Tx, documentIds: string[]): Promise<BelegRow[]> {
  if (!documentIds.length) return []
  return tx<BelegRow[]>`
    select a.document_id as "documentId", d.number, a.kind, a.format, a.storage_key as key,
           encode(a.sha256, 'hex') as sha256, a.size_bytes::text as "sizeBytes",
           to_char(a.locked_until, 'YYYY-MM-DD') as "lockedUntil",
           to_char(r.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "archivedAt"
    from document_artifact a
    join document d on d.id = a.document_id
    left join artifact_archive r on r.artifact_id = a.id
    where a.document_id in ${tx(documentIds)}
      and a.kind in ('pdf', 'zugferd_pdf', 'zugferd_xml', 'xrechnung_xml', 'validation_report')
    order by d.document_date, d.number, a.created_at`
}

/** Originals of received invoices (as received, ADR 0008). */
async function incomingBelegeOf(tx: Tx, ids: string[]): Promise<BelegRow[]> {
  if (!ids.length) return []
  return tx<BelegRow[]>`
    select null as "documentId", coalesce(i.invoice_number, '') as number, a.kind, null as format,
           a.storage_key as key, encode(a.sha256, 'hex') as sha256, a.size_bytes::text as "sizeBytes",
           to_char(a.locked_until, 'YYYY-MM-DD') as "lockedUntil",
           to_char(r.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "archivedAt",
           i.supplier_name as supplier, i.filename, i.id as "incomingId"
    from document_artifact a
    join incoming_invoice i on i.id = a.incoming_invoice_id
    left join artifact_archive r on r.artifact_id = a.id
    where a.incoming_invoice_id in ${tx(ids)}
    order by i.invoice_date nulls last, i.received_at`
}

interface IncomingRow {
  id: string
  status: string
  documentKind: 'invoice' | 'credit_note'
  source: string
  supplierName: string | null
  supplierVatId: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  net: string
  tax: string
  gross: string
  reverseCharge: boolean
  receivedAt: string
  confirmedAt: string | null
  paidOn: string | null
  closeReason: string | null
  filename: string
  creditorNumber: string | null
}

/**
 * Received invoices of a period (by invoice date; not yet dated ones by the day of receipt) with
 * their tax lines and allocations (input tax split per allocation, exact per rate).
 */
async function incomingOf(tx: Tx, from: string, to: string, statuses: string[]) {
  const invoices = await tx<IncomingRow[]>`
    select i.id, i.status, i.document_kind as "documentKind", i.source, i.supplier_name as "supplierName",
           i.supplier_vat_id as "supplierVatId", i.invoice_number as "invoiceNumber",
           to_char(i.invoice_date, 'YYYY-MM-DD') as "invoiceDate", to_char(i.due_date, 'YYYY-MM-DD') as "dueDate",
           i.net_cents::text as net, i.tax_cents::text as tax, i.gross_cents::text as gross,
           i.reverse_charge as "reverseCharge",
           to_char(i.received_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "receivedAt",
           to_char(i.confirmed_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "confirmedAt",
           to_char(i.paid_on, 'YYYY-MM-DD') as "paidOn", i.close_reason as "closeReason", i.filename,
           (select c.creditor_number from contact c where c.id = i.contact_id) as "creditorNumber"
    from incoming_invoice i
    where i.status in ${tx(statuses)}
      and coalesce(i.invoice_date, (i.received_at at time zone 'Europe/Berlin')::date)
          between ${from}::date and ${to}::date
    order by coalesce(i.invoice_date, (i.received_at at time zone 'Europe/Berlin')::date), i.received_at`
  const ids = invoices.length ? invoices.map((i) => i.id) : ['00000000-0000-0000-0000-000000000000']
  const taxes = await tx<{ invoiceId: string; rate: string; net: string; tax: string }[]>`
    select incoming_invoice_id as "invoiceId", rate_percent::text as rate, net_cents::text as net,
           tax_cents::text as tax
    from incoming_invoice_tax where incoming_invoice_id in ${tx(ids)} order by position`
  const allocationRows = await tx<
    {
      invoiceId: string
      project: string | null
      projectNumber: string | null
      area: string | null
      costType: CostType
      rate: string
      net: string
      description: string | null
    }[]
  >`
    select a.incoming_invoice_id as "invoiceId", p.name as project, p.number as "projectNumber",
           b.name as area, a.cost_type as "costType", a.rate_percent::text as rate, a.net_cents::text as net,
           a.description
    from incoming_invoice_allocation a
    left join project p on p.id = a.project_id
    left join business_area b on b.id = a.business_area_id
    where a.incoming_invoice_id in ${tx(ids)} order by a.position`
  const allocations = invoices.flatMap((invoice) => {
    const own = allocationRows.filter((a) => a.invoiceId === invoice.id)
    const tax = allocationTax(
      own.map((a) => ({
        projectId: null,
        businessAreaId: null,
        costType: a.costType,
        ratePercent: a.rate,
        netCents: BigInt(a.net),
      })),
      taxes
        .filter((t) => t.invoiceId === invoice.id)
        .map((t) => ({ ratePercent: t.rate, netCents: BigInt(t.net), taxCents: BigInt(t.tax) })),
    )
    return own.map((a, index) => ({ ...a, taxCents: tax[index] as bigint }))
  })
  return { invoices, taxes, allocations }
}

/** Renders and archives the PDF original of documents that have none yet (e.g. render failed once). */
async function ensureOriginals(
  services: Services,
  auth: AuthContext,
  documentIds: string[],
  log?: FastifyBaseLogger,
) {
  if (!documentIds.length) return
  const missing = await inTenant(
    services,
    auth,
    (tx) =>
      tx<{ id: string }[]>`
      select d.id from document d
      where d.id in ${tx(documentIds)}
        and not exists (select 1 from document_artifact a
                        where a.document_id = d.id and a.kind in ('pdf', 'zugferd_pdf'))`,
  )
  for (const { id } of missing) {
    // Best effort: a document that cannot be rendered is listed without original, not fatal.
    await archiveDocumentPdf(services, auth, id).catch((error: unknown) =>
      log?.warn({ err: error, document: id }, 'PDF original could not be created for export'),
    )
  }
}

/** ZIP entries for the originals, streamed from the files volume or the WORM archive. */
function belegEntries(services: Services, rows: BelegRow[], folder: string): ZipEntry[] {
  return rows.map((row) => ({
    name: `${folder}/${belegFile(row)}`,
    data: (async function* () {
      const original = await openArtifact(services, row.key)
      if (!original) throw new Error(`original ${row.key} missing`)
      yield* original
    })(),
  }))
}

export function registerExportRoutes(app: FastifyInstance, services: Services) {
  const logExport = (auth: AuthContext, kind: string) =>
    audit(services, auth.tenantId, auth.userId, `export:${kind}`)

  /** DATEV Buchungsstapel (EXTF) for the tax advisor: invoices per tax rate, payments, Kürzungen. */
  app.get('/api/v1/exports/datev', async (request, reply) => {
    const auth = requirePermission(request, 'export.run')
    const { from, to, belege } = parse(periodQuery, request.query)
    const withBelege = belege === 'true'
    if (withBelege) {
      const ids = await inTenant(services, auth, async (tx) =>
        (await invoicesOf(tx, from, to)).map((i) => i.id),
      )
      await ensureOriginals(services, auth, ids, request.log)
    }
    const { file, originals } = await inTenant(services, auth, async (tx) => {
      const settings = await datevSettings(tx)
      if (!settings.consultantNumber || !settings.clientNumber) {
        throw new HttpError(
          409,
          'Bitte zuerst Berater- und Mandantennummer unter Einstellungen › DATEV eintragen.',
        )
      }
      const defaults = DATEV_DEFAULTS[settings.chart]
      const incomingAccounts = {
        material: settings.expenseAccounts.material ?? defaults.expense.material,
        labor: settings.expenseAccounts.labor ?? defaults.expense.labor,
        equipment: settings.expenseAccounts.equipment ?? defaults.expense.equipment,
        subcontract: settings.expenseAccounts.subcontract ?? defaults.expense.subcontract,
        other: settings.expenseAccounts.other ?? defaults.expense.other,
        reverseCharge: settings.expenseAccounts.reverseCharge ?? defaults.expense.reverseCharge,
        creditor: settings.creditorAccount ?? defaults.creditor,
        bank: settings.bankAccount ?? defaults.bank,
      }
      const accounts = {
        standard19: settings.revenueAccounts.standard19 ?? defaults.standard19,
        reduced7: settings.revenueAccounts.reduced7 ?? defaults.reduced7,
        reverseCharge: settings.revenueAccounts.reverseCharge ?? defaults.reverseCharge,
        exempt: settings.revenueAccounts.exempt ?? defaults.exempt,
        bank: settings.bankAccount ?? defaults.bank,
      }
      const invoices = await invoicesOf(tx, from, to)
      const lines = await tx<
        { documentId: string; category: string; rate: string; net: string; tax: string }[]
      >`
        select document_id as "documentId", tax_category as category, rate_percent::text as rate,
               net_cents::text as net, tax_cents::text as tax
        from document_tax_line where document_id in ${tx(invoices.length ? invoices.map((i) => i.id) : ['00000000-0000-0000-0000-000000000000'])}`
      const exportInvoices: ExportInvoice[] = invoices.map((i) => ({
        number: i.number,
        date: i.date,
        customerAccount: customerAccount(i.customerNumber),
        customerName: i.customerName,
        taxLines: lines
          .filter((l) => l.documentId === i.id)
          .map((l) => ({
            category: l.category,
            ratePercent: l.rate,
            netCents: BigInt(l.net) * BigInt(i.sign),
            taxCents: BigInt(l.tax) * BigInt(i.sign),
          })),
      }))
      const payments: ExportPayment[] = (
        await tx<
          {
            number: string
            date: string
            amount: string
            customerNumber: string | null
            customerName: string
          }[]
        >`
          select d.number, to_char(p.paid_on, 'YYYY-MM-DD') as date, p.amount_cents::text as amount,
                 c.number as "customerNumber", coalesce(d.recipient_snapshot ->> 'name', c.display_name, '') as "customerName"
          from payment p join document d on d.id = p.invoice_id left join contact c on c.id = d.contact_id
          where p.paid_on between ${from}::date and ${to}::date
          order by p.paid_on, d.number`
      ).map((p) => ({
        invoiceNumber: p.number,
        date: p.date,
        amountCents: BigInt(p.amount),
        customerAccount: customerAccount(p.customerNumber),
        customerName: p.customerName,
      }))
      // Accepted Kürzungen (Rabatt/Minderung, sonstiger Abzug) reduce revenue; Skonto, Einbehalt,
      // Bauumlage and Bankgebühr stay out. Bestrittene Kürzungen are still claimed, so not exported;
      // a Gegenbuchung follows the flag of its original. Booking date = entry date (Berlin).
      const adjustmentRows = await tx<
        {
          invoiceId: string
          number: string
          date: string
          amount: string
          sign: number
          reversal: boolean
          customerNumber: string | null
          customerName: string
        }[]
      >`
        select d.id as "invoiceId", d.number,
               to_char(a.created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as date,
               a.amount_cents::text as amount,
               case when d.type = 'credit_note' then -1 else 1 end as sign,
               a.reverses_adjustment_id is not null as reversal,
               c.number as "customerNumber", coalesce(d.recipient_snapshot ->> 'name', c.display_name, '') as "customerName"
        from receivable_adjustment a
        left join receivable_adjustment o on o.id = a.reverses_adjustment_id
        join document d on d.id = a.invoice_id
        left join contact c on c.id = d.contact_id
        where a.kind in ('short_payment', 'other')
          and not coalesce(o.disputed, a.disputed)
          and (a.created_at at time zone 'Europe/Berlin')::date between ${from}::date and ${to}::date
        order by a.created_at, d.number`
      const adjustmentLines = adjustmentRows.length
        ? await tx<
            { documentId: string; category: string; rate: string; net: string; tax: string }[]
          >`
            select document_id as "documentId", tax_category as category, rate_percent::text as rate,
                   net_cents::text as net, tax_cents::text as tax
            from document_tax_line where document_id in ${tx([...new Set(adjustmentRows.map((a) => a.invoiceId))])}`
        : []
      const adjustments: ExportAdjustment[] = adjustmentRows.map((a) => ({
        invoiceNumber: a.number,
        date: a.date,
        amountCents: BigInt(a.amount) * BigInt(a.sign),
        customerAccount: customerAccount(a.customerNumber),
        customerName: a.customerName,
        reversal: a.reversal,
        taxLines: adjustmentLines
          .filter((l) => l.documentId === a.invoiceId)
          .map((l) => ({
            category: l.category,
            ratePercent: l.rate,
            netCents: BigInt(l.net),
            taxCents: BigInt(l.tax),
          })),
      }))
      // Eingangsrechnungen: confirmed ones by invoice date, payments by payment date.
      const incoming = await incomingOf(tx, from, to, ['confirmed'])
      const exportIncoming: ExportIncoming[] = incoming.invoices.map((i) => ({
        invoiceNumber: i.invoiceNumber ?? '',
        date: i.invoiceDate ?? i.receivedAt,
        supplierName: i.supplierName ?? '',
        creditNote: i.documentKind === 'credit_note',
        reverseCharge: i.reverseCharge,
        creditorAccount: i.creditorNumber,
        allocations: incoming.allocations
          .filter((a) => a.invoiceId === i.id)
          .map((a) => ({
            costType: a.costType,
            ratePercent: a.rate,
            netCents: BigInt(a.net),
            taxCents: a.taxCents,
          })),
      }))
      const incomingPayments: ExportIncomingPayment[] = (
        await tx<
          {
            number: string | null
            date: string
            gross: string
            kind: string
            supplier: string | null
            creditor: string | null
          }[]
        >`
          select invoice_number as number, to_char(paid_on, 'YYYY-MM-DD') as date, gross_cents::text as gross,
                 document_kind as kind, supplier_name as supplier,
                 (select c.creditor_number from contact c where c.id = incoming_invoice.contact_id) as creditor
          from incoming_invoice
          where status = 'confirmed' and paid_on between ${from}::date and ${to}::date
          order by paid_on, received_at`
      ).map((p) => ({
        invoiceNumber: p.number ?? '',
        date: p.date,
        supplierName: p.supplier ?? '',
        amountCents: BigInt(p.gross) * (p.kind === 'credit_note' ? -1n : 1n),
        creditorAccount: p.creditor,
      }))
      const csv = datevBookingBatch(
        {
          consultantNumber: settings.consultantNumber,
          clientNumber: settings.clientNumber,
          fiscalYearStart: fiscalYearStart(from, settings.fiscalYearStartMonth),
          accountLength: settings.accountLength,
          from,
          to,
          description: `Rechnungen ${germanDate(from)}-${germanDate(to)}`,
          createdAt: new Date(),
        },
        [
          ...datevBookings(exportInvoices, payments, accounts, adjustments),
          ...incomingBookings(exportIncoming, incomingPayments, incomingAccounts),
        ],
      )
      // Belege: only the PDF originals (Belegfeld 1 = file name), as DATEV expects images/PDFs.
      const originals = withBelege
        ? (
            await belegeOf(
              tx,
              invoices.map((i) => i.id),
            )
          )
            .filter((b) => b.kind === 'pdf' || b.kind === 'zugferd_pdf')
            .concat(
              await incomingBelegeOf(
                tx,
                incoming.invoices.map((i) => i.id),
              ),
            )
        : []
      return { file: csv, originals }
    })
    await logExport(auth, withBelege ? 'datev+belege' : 'datev')
    const csvName = `EXTF_Buchungsstapel_${from}_${to}.csv`
    if (!withBelege) {
      return sendFile(reply, csvName, 'text/csv; charset=windows-1252', encodeWindows1252(file))
    }
    return sendFile(
      reply,
      `DATEV_${from}_${to}.zip`,
      'application/zip',
      Readable.from(
        zipStream([
          { name: csvName, data: encodeWindows1252(file) },
          ...belegEntries(services, originals, 'Belege'),
        ]),
      ),
    )
  })

  /** GoBD-Datenträgerüberlassung (Z3): CSV files + index.xml (Beschreibungsstandard). */
  app.get('/api/v1/exports/gobd', async (request, reply) => {
    const auth = requirePermission(request, 'export.run')
    const { from, to } = parse(periodQuery, request.query)
    await ensureOriginals(
      services,
      auth,
      await inTenant(services, auth, async (tx) =>
        (await invoicesOf(tx, from, to)).map((i) => i.id),
      ),
    )
    const { tables, company, originals } = await inTenant(services, auth, async (tx) => {
      const [company] = await tx<{ name: string; city: string | null }[]>`
        select name, city from tenant where id = current_tenant_id()`
      const invoices = await invoicesOf(tx, from, to)
      const incoming = await incomingOf(tx, from, to, [
        'review',
        'confirmed',
        'cancelled',
        'discarded',
      ])
      const originals = [
        ...(await belegeOf(
          tx,
          invoices.map((i) => i.id),
        )),
        ...(await incomingBelegeOf(
          tx,
          incoming.invoices.map((i) => i.id),
        )),
      ]
      const ids = invoices.length
        ? invoices.map((i) => i.id)
        : ['00000000-0000-0000-0000-000000000000']
      const items = await tx<
        {
          number: string
          oz: string | null
          type: string
          text: string | null
          quantity: string | null
          unit: string | null
          price: string | null
          total: string | null
          rate: string | null
        }[]
      >`
        select d.number, i.oz, i.position_type as type, i.short_text as text, i.quantity::text as quantity,
               i.unit_symbol as unit, i.unit_price_cents::text as price, i.total_cents::text as total,
               i.tax_rate_percent::text as rate
        from document_item i join document d on d.id = i.document_id
        where i.document_id in ${tx(ids)} order by d.document_date, d.number, i.sort`
      const taxes = await tx<
        { number: string; category: string; rate: string; net: string; tax: string }[]
      >`
        select d.number, l.tax_category as category, l.rate_percent::text as rate, l.net_cents::text as net,
               l.tax_cents::text as tax
        from document_tax_line l join document d on d.id = l.document_id where l.document_id in ${tx(ids)}`
      const payments = await tx<
        { number: string; date: string; amount: string; method: string; reference: string | null }[]
      >`
        select d.number, to_char(p.paid_on, 'YYYY-MM-DD') as date, p.amount_cents::text as amount, p.method, p.reference
        from payment p join document d on d.id = p.invoice_id
        where p.paid_on between ${from}::date and ${to}::date order by p.paid_on`
      const customers = await tx<
        {
          number: string
          name: string
          street: string | null
          postalCode: string | null
          city: string | null
          country: string | null
          vatId: string | null
        }[]
      >`
        select c.number, c.display_name as name, a.street, a.postal_code as "postalCode", a.city,
               a.country_code as country, c.vat_id as "vatId"
        from contact c left join lateral (
          select * from contact_address where contact_id = c.id order by (kind = 'billing') desc, (kind = 'main') desc limit 1
        ) a on true
        where c.number is not null order by c.number`
      const log = await tx<
        {
          at: string
          seq: string
          action: string
          entity: string
          entityId: string | null
          hash: string
        }[]
      >`
        select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at, seq::text, action, entity,
               entity_id::text as "entityId", encode(hash, 'hex') as hash
        from audit_event
        where created_at >= ${from}::date and created_at < ${to}::date + 1
          and entity in ('document', 'document_item', 'payment', 'receivable_adjustment', 'dunning_notice',
                         'incoming_invoice', 'incoming_invoice_tax', 'incoming_invoice_allocation')
        order by seq`
      const tables: GobdTable[] = [
        {
          file: 'rechnungen.csv',
          name: 'Rechnungsausgang',
          description: 'Festgeschriebene Ausgangsrechnungen, Stornorechnungen und Gutschriften',
          columns: [
            { name: 'Rechnungsnummer', type: 'text', primaryKey: true },
            { name: 'Belegart', type: 'text' },
            { name: 'Rechnungsart', type: 'text' },
            { name: 'Rechnungsdatum', type: 'date' },
            { name: 'Leistung_von', type: 'date' },
            { name: 'Leistung_bis', type: 'date' },
            { name: 'Kundennummer', type: 'text' },
            { name: 'Kunde', type: 'text' },
            { name: 'Netto', type: 'numeric', accuracy: 2 },
            { name: 'Umsatzsteuer', type: 'numeric', accuracy: 2 },
            { name: 'Brutto', type: 'numeric', accuracy: 2 },
            { name: 'Status', type: 'text' },
            { name: 'Festgeschrieben_am', type: 'date' },
            { name: 'Storniert_Rechnung', type: 'text' },
          ],
          rows: invoices.map((i) => [
            i.number,
            i.type === 'credit_note' ? 'Gutschrift' : 'Rechnung',
            i.invoiceKind ?? '',
            germanDate(i.date),
            i.serviceFrom ? germanDate(i.serviceFrom) : '',
            i.serviceTo ? germanDate(i.serviceTo) : '',
            i.customerNumber ?? '',
            i.customerName,
            germanAmount(i.net),
            germanAmount(i.tax),
            germanAmount(i.gross),
            i.status,
            germanDate(i.finalizedAt),
            i.cancelsNumber ?? '',
          ]),
        },
        {
          file: 'rechnungspositionen.csv',
          name: 'Rechnungspositionen',
          description: 'Positionen der Ausgangsrechnungen',
          columns: [
            { name: 'Rechnungsnummer', type: 'text' },
            { name: 'Position', type: 'text' },
            { name: 'Positionsart', type: 'text' },
            { name: 'Leistung', type: 'text' },
            { name: 'Menge', type: 'numeric', accuracy: 4 },
            { name: 'Einheit', type: 'text' },
            { name: 'Einzelpreis', type: 'numeric', accuracy: 2 },
            { name: 'Gesamtpreis', type: 'numeric', accuracy: 2 },
            { name: 'Steuersatz', type: 'numeric', accuracy: 2 },
          ],
          rows: items.map((i) => [
            i.number,
            i.oz ?? '',
            i.type,
            i.text ?? '',
            i.quantity ? i.quantity.replace('.', ',') : '',
            i.unit ?? '',
            i.price === null ? '' : germanAmount(i.price),
            i.total === null ? '' : germanAmount(i.total),
            i.rate ? i.rate.replace('.', ',') : '',
          ]),
        },
        {
          file: 'umsatzsteuer.csv',
          name: 'Umsatzsteuer',
          description: 'Umsatzsteuer je Rechnung und Steuersatz',
          columns: [
            { name: 'Rechnungsnummer', type: 'text' },
            { name: 'Steuerkategorie', type: 'text' },
            { name: 'Steuersatz', type: 'numeric', accuracy: 2 },
            { name: 'Netto', type: 'numeric', accuracy: 2 },
            { name: 'Steuer', type: 'numeric', accuracy: 2 },
          ],
          rows: taxes.map((t) => [
            t.number,
            t.category,
            t.rate.replace('.', ','),
            germanAmount(t.net),
            germanAmount(t.tax),
          ]),
        },
        {
          file: 'zahlungen.csv',
          name: 'Zahlungseingaenge',
          description: 'Zahlungseingänge zu Ausgangsrechnungen',
          columns: [
            { name: 'Rechnungsnummer', type: 'text' },
            { name: 'Zahlungsdatum', type: 'date' },
            { name: 'Betrag', type: 'numeric', accuracy: 2 },
            { name: 'Zahlungsart', type: 'text' },
            { name: 'Referenz', type: 'text' },
          ],
          rows: payments.map((p) => [
            p.number,
            germanDate(p.date),
            germanAmount(p.amount),
            p.method,
            p.reference ?? '',
          ]),
        },
        {
          file: 'eingangsrechnungen.csv',
          name: 'Rechnungseingang',
          description:
            'Empfangene Rechnungen und Gutschriften (Eingangsrechnungen) mit Prüf- und Zahlstatus',
          columns: [
            { name: 'ID', type: 'text', primaryKey: true },
            { name: 'Lieferant', type: 'text' },
            { name: 'USt_IdNr', type: 'text' },
            { name: 'Rechnungsnummer', type: 'text' },
            { name: 'Rechnungsdatum', type: 'date' },
            { name: 'Faelligkeit', type: 'date' },
            { name: 'Belegart', type: 'text' },
            { name: 'Format', type: 'text' },
            { name: 'Netto', type: 'numeric', accuracy: 2 },
            { name: 'Umsatzsteuer', type: 'numeric', accuracy: 2 },
            { name: 'Brutto', type: 'numeric', accuracy: 2 },
            { name: 'Steuerschuldnerschaft_13b', type: 'text' },
            { name: 'Status', type: 'text' },
            { name: 'Eingang_am', type: 'date' },
            { name: 'Geprueft_am', type: 'date' },
            { name: 'Bezahlt_am', type: 'date' },
            { name: 'Grund_Storno_Verworfen', type: 'text' },
            { name: 'Datei', type: 'text' },
          ],
          rows: incoming.invoices.map((i) => [
            i.id,
            i.supplierName ?? '',
            i.supplierVatId ?? '',
            i.invoiceNumber ?? '',
            i.invoiceDate ? germanDate(i.invoiceDate) : '',
            i.dueDate ? germanDate(i.dueDate) : '',
            i.documentKind === 'credit_note' ? 'Gutschrift' : 'Rechnung',
            i.source,
            germanAmount(i.net),
            germanAmount(i.tax),
            germanAmount(i.gross),
            i.reverseCharge ? 'ja' : 'nein',
            INCOMING_STATUS[i.status] ?? i.status,
            germanDate(i.receivedAt),
            i.confirmedAt ? germanDate(i.confirmedAt) : '',
            i.paidOn ? germanDate(i.paidOn) : '',
            i.closeReason ?? '',
            i.filename,
          ]),
        },
        {
          file: 'eingangsrechnungen_steuer.csv',
          name: 'Vorsteuer',
          description: 'Umsatzsteuer der Eingangsrechnungen je Steuersatz',
          columns: [
            { name: 'ID', type: 'text' },
            { name: 'Steuersatz', type: 'numeric', accuracy: 2 },
            { name: 'Netto', type: 'numeric', accuracy: 2 },
            { name: 'Steuer', type: 'numeric', accuracy: 2 },
          ],
          rows: incoming.taxes.map((t) => [
            t.invoiceId,
            t.rate.replace('.', ','),
            germanAmount(t.net),
            germanAmount(t.tax),
          ]),
        },
        {
          file: 'eingangsrechnungen_zuweisung.csv',
          name: 'Kostenzuweisung',
          description: 'Zuweisung der Eingangsrechnungen auf Projekte und Betriebsbereiche',
          columns: [
            { name: 'ID', type: 'text' },
            { name: 'Projektnummer', type: 'text' },
            { name: 'Projekt', type: 'text' },
            { name: 'Betriebsbereich', type: 'text' },
            { name: 'Kostenart', type: 'text' },
            { name: 'Steuersatz', type: 'numeric', accuracy: 2 },
            { name: 'Netto', type: 'numeric', accuracy: 2 },
            { name: 'Vorsteuer', type: 'numeric', accuracy: 2 },
            { name: 'Beschreibung', type: 'text' },
          ],
          rows: incoming.allocations.map((a) => [
            a.invoiceId,
            a.projectNumber ?? '',
            a.project ?? '',
            a.area ?? '',
            a.costType,
            a.rate.replace('.', ','),
            germanAmount(a.net),
            germanAmount(a.taxCents.toString()),
            a.description ?? '',
          ]),
        },
        {
          file: 'kunden.csv',
          name: 'Debitoren',
          description: 'Kunden (Debitoren) mit Kundennummer',
          columns: [
            { name: 'Kundennummer', type: 'text', primaryKey: true },
            { name: 'Name', type: 'text' },
            { name: 'Strasse', type: 'text' },
            { name: 'PLZ', type: 'text' },
            { name: 'Ort', type: 'text' },
            { name: 'Land', type: 'text' },
            { name: 'USt_IdNr', type: 'text' },
          ],
          rows: customers.map((c) => [
            c.number,
            c.name,
            c.street ?? '',
            c.postalCode ?? '',
            c.city ?? '',
            c.country ?? '',
            c.vatId ?? '',
          ]),
        },
        {
          file: 'protokoll.csv',
          name: 'Aenderungsprotokoll',
          description: 'Änderungsprotokoll (Hash-Kette) zu Belegen und Zahlungen',
          columns: [
            { name: 'Laufnummer', type: 'numeric', primaryKey: true },
            { name: 'Zeitpunkt_UTC', type: 'text' },
            { name: 'Aktion', type: 'text' },
            { name: 'Tabelle', type: 'text' },
            { name: 'Datensatz', type: 'text' },
            { name: 'Hash_SHA256', type: 'text' },
          ],
          rows: log.map((l) => [l.seq, l.at, l.action, l.entity, l.entityId ?? '', l.hash]),
        },
        {
          file: 'belege.csv',
          name: 'Belege',
          description:
            'Unveränderte Originale der Ausgangsrechnungen (PDF/A, E-Rechnung, Prüfbericht) und der Eingangsrechnungen (wie empfangen) im Ordner belege, mit SHA-256',
          columns: [
            { name: 'Rechnungsnummer', type: 'text' },
            { name: 'Datei', type: 'text', primaryKey: true },
            { name: 'Art', type: 'text' },
            { name: 'SHA256', type: 'text' },
            { name: 'Groesse_Bytes', type: 'numeric', accuracy: 0 },
            { name: 'Aufbewahrung_bis', type: 'date' },
            { name: 'Revisionssicher_archiviert_UTC', type: 'text' },
          ],
          rows: originals.map((b) => [
            b.number,
            `belege/${belegFile(b)}`,
            BELEG_KIND[b.kind],
            b.sha256,
            b.sizeBytes,
            germanDate(b.lockedUntil),
            b.archivedAt ?? '',
          ]),
        },
      ]
      return { tables, company: company as { name: string; city: string | null }, originals }
    })
    await logExport(auth, 'gobd')
    const entries: ZipEntry[] = [
      {
        name: 'index.xml',
        data: gobdIndexXml(
          {
            name: company.name,
            location: company.city ?? '',
            comment: `GoBD-Datenträgerüberlassung ${germanDate(from)} bis ${germanDate(to)}`,
          },
          { from, to },
          tables,
        ),
      },
      ...tables.map((table) => ({ name: table.file, data: gobdTableCsv(table) })),
      ...belegEntries(services, originals, 'belege'),
    ]
    return sendFile(
      reply,
      `GoBD_Z3_${from}_${to}.zip`,
      'application/zip',
      Readable.from(zipStream(entries)),
    )
  })

  /** Complete data export of the company (JSON per table + all files of the Ablage). */
  app.get('/api/v1/exports/full', async (request, reply) => {
    const auth = requirePermission(request, 'export.run')
    const TABLES = [
      'contact',
      'contact_channel',
      'contact_address',
      'contact_link',
      'project_status',
      'project',
      'project_member',
      'project_folder',
      'document',
      'document_item',
      'item_calc_component',
      'document_tax_line',
      'document_deduction',
      'document_artifact',
      'artifact_archive',
      'change_order_meta',
      'change_order_item_decision',
      'measurement_sheet',
      'measurement_location',
      'measurement_line',
      'report_template',
      'report',
      'report_photo',
      'report_signature',
      'payment',
      'receivable_adjustment',
      'dunning_notice',
      'base_interest_rate',
      'business_area',
      'incoming_invoice',
      'incoming_invoice_tax',
      'incoming_invoice_allocation',
      'file',
      'catalog_folder',
      'catalog_item',
      'catalog_component',
      'supplier_catalog',
      'supplier_discount',
      'unit',
      'tax_rate',
      'payment_term',
      'surcharge',
      'wage_group',
      'text_template',
      'filing_template',
      'number_sequence',
      'working_hours',
      'role',
      'audit_event',
    ]
    const data = await inTenant(services, auth, async (tx) => {
      const tables: Record<string, unknown[]> = {}
      for (const table of TABLES) {
        const [row] = await tx<{ rows: unknown[] }[]>`
          select coalesce(json_agg(t), '[]'::json) as rows from ${tx(table)} t`
        tables[table] = row?.rows ?? []
      }
      // Company without encrypted bank data; people only with name and e-mail (no password hashes).
      const [company] = await tx<{ row: unknown }[]>`
        select to_jsonb(t) - 'iban_enc' as row from tenant t where id = current_tenant_id()`
      tables.tenant = [company?.row]
      tables.member = [
        ...(await tx`
        select u.display_name, u.email, r.key as role from membership m
        join app_user u on u.id = m.user_id join role r on r.id = m.role_id`),
      ]
      const files = await tx<{ id: string; key: string; path: string; sha256: string }[]>`
        select f.id, f.storage_key as key,
               concat_ws('/', coalesce(p.number, p.id::text), coalesce(d.name, 'Ohne Ordner'), left(f.id::text, 8) || '_' || f.filename) as path,
               encode(f.sha256, 'hex') as sha256
        from file f join project p on p.id = f.project_id left join project_folder d on d.id = f.folder_id
        order by f.created_at`
      const documents = await tx<{ id: string }[]>`
        select id from document where finalized_at is not null`
      const received = await tx<{ id: string }[]>`select id from incoming_invoice`
      const originals = [
        ...(await belegeOf(
          tx,
          documents.map((d) => d.id),
        )),
        ...(await incomingBelegeOf(
          tx,
          received.map((r) => r.id),
        )),
      ]
      return { tables, files, originals }
    })
    await logExport(auth, 'full')
    const storage = services.storage
    async function* entries(): AsyncGenerator<ZipEntry> {
      yield {
        name: 'manifest.json',
        data: JSON.stringify(
          {
            format: 'openplancraft-export',
            version: 1,
            createdAt: new Date().toISOString(),
            application: { name: services.config.APP_NAME },
            tables: Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length])),
            files: data.files.map((f) => ({ path: `ablage/${f.path}`, sha256: f.sha256 })),
            belege: data.originals.map((b) => ({
              path: `belege/${belegFile(b)}`,
              sha256: b.sha256,
            })),
          },
          null,
          2,
        ),
      }
      for (const [table, rows] of Object.entries(data.tables)) {
        yield { name: `daten/${table}.json`, data: JSON.stringify(rows, null, 1) }
      }
      for (const file of data.files) {
        if ((await storage.size(file.key)) === null) continue
        yield { name: `ablage/${file.path}`, data: storage.read(file.key) }
      }
      yield* belegEntries(services, data.originals, 'belege')
    }
    return sendFile(
      reply,
      `Datenexport_${isoNow()}.zip`,
      'application/zip',
      Readable.from(zipStream(entries())),
    )
  })
}
