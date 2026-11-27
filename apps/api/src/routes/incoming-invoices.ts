import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Tx } from '@easybau/db'
import { type CostType, incomingProblems, incomingWarnings, rateKey } from '@easybau/domain'
import {
  extractPdfEinvoice,
  type IncomingEinvoice,
  IncomingEinvoiceError,
  readIncomingEinvoice,
} from '@easybau/einvoice'
import {
  type BusinessArea,
  closeIncomingRequest,
  createBusinessAreaRequest,
  type IncomingAllocation,
  type IncomingEinvoiceView,
  type IncomingInvoiceDetail,
  type IncomingInvoiceList,
  type IncomingInvoiceListItem,
  type IncomingSource,
  type IncomingStatus,
  incomingListQuery,
  incomingPaymentRequest,
  type UpdateIncomingRequest,
  updateBusinessAreaRequest,
  updateIncomingRequest,
  uploadIncomingQuery,
} from '@easybau/schemas'
import { detectFileType, sanitizeFilename } from '@easybau/storage'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { openArtifact, storeIncomingOriginal } from '../artifacts.js'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requireAuth,
  requirePermission,
  requireVisibleProject,
  type Services,
} from '../context.js'
import {
  checkIfMatch,
  decodeCursor,
  encodeCursor,
  etagOf,
  forbidden,
  HttpError,
  notFound,
  parse,
} from '../http.js'
import { ValidatorUnavailableError } from '../kosit.js'
import { assignCreditorNumber, usableContact } from './contacts.js'
import { contentDisposition } from './files.js'
import { todayOf } from './receivable-state.js'
import { datevSettings } from './settings.js'

/**
 * Eingangsrechnungen (P1.11). The received file is archived unchanged the moment it arrives
 * (document_artifact `incoming_original`, WORM). E-invoices (ZUGFeRD PDF, XRechnung CII/UBL) are
 * read and checked by KoSIT; their data prefill the review. "Prüfung bestätigen" freezes the
 * invoice (trigger 0027); afterwards only the payment status changes or it is cancelled.
 */

const idParam = z.object({ id: z.uuid('Ungültige ID.') })
const originalQuery = z.object({ download: z.enum(['true', 'false']).optional() })
const ISO = (tx: Tx, column: string) =>
  tx.unsafe(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)

const ALLOWED: Record<string, IncomingSource> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/png': 'image',
  'application/xml': 'xrechnung_cii',
}

/** Strings instead of bigint, numbers for the API (cents stay integers). */
const num = (value: bigint | null) => (value === null ? null : Number(value))

function einvoiceView(e: IncomingEinvoice): IncomingEinvoiceView {
  return {
    ...e,
    lines: e.lines.map((l) => ({ ...l, netCents: num(l.netCents) })),
    allowanceCharges: e.allowanceCharges.map((a) => ({ ...a, amountCents: num(a.amountCents) })),
    vatBreakdown: e.vatBreakdown.map((v) => ({
      ...v,
      baseCents: num(v.baseCents),
      taxCents: num(v.taxCents),
    })),
    totals: {
      lineNetCents: num(e.totals.lineNetCents),
      allowanceCents: num(e.totals.allowanceCents),
      chargeCents: num(e.totals.chargeCents),
      netCents: num(e.totals.netCents),
      taxCents: num(e.totals.taxCents),
      grossCents: num(e.totals.grossCents),
      prepaidCents: num(e.totals.prepaidCents),
      dueCents: num(e.totals.dueCents),
    },
  }
}

const addressOf = (p: IncomingEinvoice['seller']) =>
  [
    p.street,
    p.streetExtra,
    [p.postalCode, p.city].filter(Boolean).join(' '),
    p.countryCode && p.countryCode !== 'DE' ? p.countryCode : null,
  ]
    .filter((v) => v)
    .join(', ') || null

const normalizeVatId = (value: string | null) =>
  value ? value.replace(/[\s.-]/g, '').toUpperCase() : null

/** Readers without `incoming_invoice.write` and without all projects see only their projects. */
export function incomingVisibility(tx: Tx, auth: AuthContext) {
  if (auth.permissions.has('incoming_invoice.write') || auth.permissions.has('project.read_all')) {
    return tx`true`
  }
  return tx`i.status in ('confirmed', 'cancelled') and exists (
    select 1 from incoming_invoice_allocation a join project p on p.id = a.project_id
    where a.incoming_invoice_id = i.id and ${projectVisibility(tx, auth)})`
}

interface Row {
  id: string
  status: IncomingStatus
  documentKind: 'invoice' | 'credit_note'
  source: IncomingSource
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  net: string
  tax: string
  gross: string
  paidOn: string | null
  reverseCharge: boolean
  einvoiceValid: boolean | null
  allocatedTo: string[] | null
  receivedAt: string
  sortDate: string
  receivedVia: 'upload' | 'email'
  emailFrom: string | null
  emailSubject: string | null
}

const listColumns = (tx: Tx) => tx`
  i.id, i.status, i.document_kind as "documentKind", i.source, i.supplier_name as "supplierName",
  i.invoice_number as "invoiceNumber", to_char(i.invoice_date, 'YYYY-MM-DD') as "invoiceDate",
  to_char(i.due_date, 'YYYY-MM-DD') as "dueDate", i.net_cents::text as net, i.tax_cents::text as tax,
  i.gross_cents::text as gross, to_char(i.paid_on, 'YYYY-MM-DD') as "paidOn",
  i.reverse_charge as "reverseCharge", i.einvoice_valid as "einvoiceValid",
  (select array_agg(distinct coalesce(p.name, b.name) order by coalesce(p.name, b.name))
   from incoming_invoice_allocation a
   left join project p on p.id = a.project_id
   left join business_area b on b.id = a.business_area_id
   where a.incoming_invoice_id = i.id) as "allocatedTo",
  ${ISO(tx, 'i.received_at')} as "receivedAt",
  i.received_via as "receivedVia", i.email_from as "emailFrom", i.email_subject as "emailSubject",
  to_char(coalesce(i.invoice_date, (i.received_at at time zone 'Europe/Berlin')::date), 'YYYY-MM-DD') as "sortDate"`

function toListItem(row: Row, today: string): IncomingInvoiceListItem {
  return {
    id: row.id,
    status: row.status,
    documentKind: row.documentKind,
    source: row.source,
    supplierName: row.supplierName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    netCents: Number(row.net),
    grossCents: Number(row.gross),
    paidOn: row.paidOn,
    overdue:
      row.status === 'confirmed' &&
      row.documentKind === 'invoice' &&
      row.paidOn === null &&
      row.dueDate !== null &&
      row.dueDate < today,
    reverseCharge: row.reverseCharge,
    einvoiceValid: row.einvoiceValid,
    allocatedTo: row.allocatedTo ?? [],
    receivedAt: row.receivedAt,
    receivedVia: row.receivedVia,
    emailFrom: row.emailFrom,
    emailSubject: row.emailSubject,
  }
}

interface DetailRow extends Row {
  filename: string
  mimeType: string
  sizeBytes: string
  sha256: string
  contactId: string | null
  supplierVatId: string | null
  supplierTaxNumber: string | null
  supplierAddress: string | null
  supplierIban: string | null
  note: string | null
  paymentNote: string | null
  einvoice: IncomingEinvoiceView | null
  einvoiceProfile: string | null
  einvoiceEn16931: boolean | null
  einvoiceMessages: IncomingInvoiceDetail['einvoiceMessages']
  uploadedBy: string | null
  confirmedAt: string | null
  confirmedBy: string | null
  closedAt: string | null
  closeReason: string | null
  updatedAt: Date
  retainUntil: string
  archived: boolean
}

/** Loads an incoming invoice the user may see, with everything the review needs. */
export async function loadIncoming(
  tx: Tx,
  auth: AuthContext,
  id: string,
): Promise<{ detail: IncomingInvoiceDetail; updatedAt: Date } | null> {
  const [row] = await tx<DetailRow[]>`
    select ${listColumns(tx)}, i.filename, i.mime_type as "mimeType", i.size_bytes::text as "sizeBytes",
           encode(i.sha256, 'hex') as sha256, i.contact_id as "contactId",
           i.supplier_vat_id as "supplierVatId", i.supplier_tax_number as "supplierTaxNumber",
           i.supplier_address as "supplierAddress", i.supplier_iban as "supplierIban", i.note,
           i.payment_note as "paymentNote", i.einvoice, i.einvoice_profile as "einvoiceProfile",
           i.einvoice_en16931 as "einvoiceEn16931", i.einvoice_messages as "einvoiceMessages",
           up.display_name as "uploadedBy", ${ISO(tx, 'i.confirmed_at')} as "confirmedAt",
           cu.display_name as "confirmedBy", ${ISO(tx, 'i.closed_at')} as "closedAt",
           i.close_reason as "closeReason", i.updated_at as "updatedAt",
           to_char(a.locked_until, 'YYYY-MM-DD') as "retainUntil",
           exists (select 1 from artifact_archive r where r.artifact_id = a.id) as archived
    from incoming_invoice i
    join document_artifact a on a.incoming_invoice_id = i.id
    left join app_user up on up.id = i.uploaded_by
    left join app_user cu on cu.id = i.confirmed_by
    where i.id = ${id} and ${incomingVisibility(tx, auth)}`
  if (!row) return null
  const taxLines = await tx<{ ratePercent: string; net: string; tax: string }[]>`
    select rate_percent::text as "ratePercent", net_cents::text as net, tax_cents::text as tax
    from incoming_invoice_tax where incoming_invoice_id = ${id} order by position, rate_percent desc`
  const allocations = await tx<(Omit<IncomingAllocation, 'netCents'> & { net: string })[]>`
    select a.id, a.project_id as "projectId", p.name as "projectName",
           a.business_area_id as "businessAreaId", b.name as "businessAreaName",
           a.cost_type as "costType", a.rate_percent::text as "ratePercent", a.net_cents::text as net,
           a.description, a.line_id as "lineId"
    from incoming_invoice_allocation a
    left join project p on p.id = a.project_id
    left join business_area b on b.id = a.business_area_id
    where a.incoming_invoice_id = ${id} order by a.position, a.id`
  const duplicates = row.invoiceNumber
    ? await tx<IncomingInvoiceDetail['duplicates']>`
        select i.id, i.invoice_number as "invoiceNumber", to_char(i.invoice_date, 'YYYY-MM-DD') as "invoiceDate",
               i.status
        from incoming_invoice i
        where i.id <> ${id} and i.status in ('review', 'confirmed')
          and lower(i.invoice_number) = lower(${row.invoiceNumber})
          and (coalesce(i.contact_id, '00000000-0000-0000-0000-000000000000') = coalesce(${row.contactId}::uuid, '00000000-0000-0000-0000-000000000000')
               and (${row.contactId}::uuid is not null
                    or lower(coalesce(i.supplier_name, '')) = lower(coalesce(${row.supplierName}, ''))))
        order by i.received_at limit 5`
    : []
  const today = todayOf(tx)
  const check = {
    supplierName: row.supplierName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    netCents: BigInt(row.net),
    taxCents: BigInt(row.tax),
    grossCents: BigInt(row.gross),
    reverseCharge: row.reverseCharge,
    taxLines: taxLines.map((l) => ({
      ratePercent: l.ratePercent,
      netCents: BigInt(l.net),
      taxCents: BigInt(l.tax),
    })),
    allocations: allocations.map((a) => ({
      projectId: a.projectId,
      businessAreaId: a.businessAreaId,
      costType: a.costType as CostType,
      ratePercent: a.ratePercent,
      netCents: BigInt(a.net),
    })),
  }
  const problems = row.status === 'review' ? incomingProblems(check) : []
  for (const duplicate of duplicates) {
    if (row.status === 'review') {
      problems.push({
        field: 'invoiceNumber',
        message: `Diese Rechnung des Lieferanten ist bereits erfasst (Nr. ${duplicate.invoiceNumber}${
          duplicate.status === 'review' ? ', noch in Prüfung' : ''
        }).`,
      })
    }
  }
  const warnings = row.status === 'review' ? incomingWarnings(check) : []
  if (row.einvoice?.currency && row.einvoice.currency !== 'EUR') {
    warnings.push({
      field: 'grossCents',
      message: `Die Rechnung lautet auf ${row.einvoice.currency}. Bitte die Beträge in Euro eintragen.`,
    })
  }
  if (row.einvoiceEn16931 === false) {
    warnings.push({
      field: 'einvoice',
      message: `Das Profil ${row.einvoiceProfile} ist keine vollständige E-Rechnung nach EN 16931; maßgeblich ist die lesbare Rechnung.`,
    })
  }
  const canEdit = auth.permissions.has('incoming_invoice.write')
  return {
    updatedAt: row.updatedAt,
    detail: {
      ...toListItem(row, today),
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      sha256: row.sha256,
      inline: row.mimeType !== 'application/xml',
      contactId: row.contactId,
      supplierVatId: row.supplierVatId,
      supplierTaxNumber: row.supplierTaxNumber,
      supplierAddress: row.supplierAddress,
      supplierIban: row.supplierIban,
      taxCents: Number(row.tax),
      note: row.note,
      paymentNote: row.paymentNote,
      taxLines: taxLines.map((l) => ({
        ratePercent: rateKey(l.ratePercent),
        netCents: Number(l.net),
        taxCents: Number(l.tax),
      })),
      allocations: allocations.map(({ net, ...a }) => ({
        ...a,
        ratePercent: rateKey(a.ratePercent),
        netCents: Number(net),
      })),
      einvoice: row.einvoice,
      einvoiceProfile: row.einvoiceProfile,
      einvoiceEn16931: row.einvoiceEn16931,
      einvoiceMessages: row.einvoiceMessages,
      problems,
      warnings,
      duplicates,
      uploadedBy: row.uploadedBy,
      confirmedAt: row.confirmedAt,
      confirmedBy: row.confirmedBy,
      closedAt: row.closedAt,
      closeReason: row.closeReason,
      archive: { archived: row.archived, retainUntil: row.retainUntil },
      canEdit,
    },
  }
}

async function requireIncoming(tx: Tx, auth: AuthContext, id: string) {
  const loaded = await loadIncoming(tx, auth, id)
  if (!loaded) throw notFound('Die Eingangsrechnung')
  return loaded
}

/** Reads the request body completely (received invoices are parsed in memory). */
async function readBody(body: Readable, maxBytes: number, tooLarge: () => Error): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    size += (chunk as Buffer).length
    if (size > maxBytes) {
      body.resume()
      throw tooLarge()
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

interface Received {
  source: IncomingSource
  mime: string
  einvoice: IncomingEinvoice | null
  xml: string | null
  /** The XML in a PDF could not be read (shown as hint, the PDF is kept as ordinary invoice). */
  unreadable: string | null
}

function receive(filename: string, data: Buffer): Received {
  const type = detectFileType(filename, data.subarray(0, 4096))
  const source = type ? ALLOWED[type.mime] : undefined
  if (!type || !source) {
    throw new HttpError(
      415,
      'Bitte eine Rechnung als PDF (auch ZUGFeRD), XRechnung (XML) oder Foto (JPG, PNG) hochladen.',
    )
  }
  if (source === 'image')
    return { source, mime: type.mime, einvoice: null, xml: null, unreadable: null }
  if (source === 'pdf') {
    const embedded = extractPdfEinvoice(data)
    if (!embedded) return { source, mime: type.mime, einvoice: null, xml: null, unreadable: null }
    try {
      const einvoice = readIncomingEinvoice(embedded.xml)
      return { source: 'zugferd', mime: type.mime, einvoice, xml: embedded.xml, unreadable: null }
    } catch (error) {
      if (!(error instanceof IncomingEinvoiceError)) throw error
      return { source, mime: type.mime, einvoice: null, xml: null, unreadable: error.message }
    }
  }
  const xml = data.toString('utf8')
  try {
    const einvoice = readIncomingEinvoice(xml)
    return {
      source: einvoice.syntax === 'ubl' ? 'xrechnung_ubl' : 'xrechnung_cii',
      mime: type.mime,
      einvoice,
      xml,
      unreadable: null,
    }
  } catch (error) {
    if (error instanceof IncomingEinvoiceError) throw new HttpError(422, error.message)
    throw error
  }
}

type Messages = IncomingInvoiceDetail['einvoiceMessages']

/** KoSIT check of a received e-invoice: informs, never blocks receiving (the original counts). */
async function validate(
  services: Services,
  xml: string,
): Promise<{ valid: boolean | null; messages: Messages }> {
  if (!services.einvoiceValidator) {
    return {
      valid: null,
      messages: [
        { level: 'information', code: null, text: 'Keine Prüfung: KoSIT ist nicht eingerichtet.' },
      ],
    }
  }
  try {
    const { result } = await services.einvoiceValidator.validate(xml)
    return {
      valid: result.valid,
      messages: result.messages.filter((m) => m.level !== 'information').slice(0, 50),
    }
  } catch (error) {
    if (!(error instanceof ValidatorUnavailableError)) throw error
    return {
      valid: null,
      messages: [
        { level: 'information', code: null, text: 'Keine Prüfung: KoSIT war nicht erreichbar.' },
      ],
    }
  }
}

/** Taken from the e-invoice into the review (the user checks and completes them). */
function prefill(einvoice: IncomingEinvoice | null) {
  if (!einvoice) return null
  const { seller, totals } = einvoice
  const taxLines = einvoice.vatBreakdown
    .filter((v) => v.rate !== null && v.baseCents !== null)
    .map((v) => ({
      ratePercent: v.rate as string,
      netCents: v.baseCents as bigint,
      taxCents: v.taxCents ?? 0n,
    }))
  const euro = !einvoice.currency || einvoice.currency === 'EUR'
  return {
    documentKind: einvoice.documentKind,
    supplierName: seller.name,
    supplierVatId: seller.vatId,
    supplierTaxNumber: seller.taxNumber,
    supplierAddress: addressOf(seller),
    supplierIban: einvoice.payment.iban?.replace(/\s/g, '').slice(0, 34) ?? null,
    invoiceNumber: einvoice.number?.slice(0, 100) ?? null,
    invoiceDate: einvoice.issueDate,
    dueDate: einvoice.dueDate,
    netCents: euro ? (totals.netCents ?? 0n) : 0n,
    taxCents: euro ? (totals.taxCents ?? 0n) : 0n,
    grossCents: euro ? (totals.grossCents ?? 0n) : 0n,
    reverseCharge: einvoice.vatBreakdown.some((v) => v.category === 'AE'),
    taxLines: euro ? taxLines : [],
  }
}

/** Replaces tax lines and allocations of an invoice in review (checks projects/areas). */
async function writeLines(tx: Tx, auth: AuthContext, id: string, input: UpdateIncomingRequest) {
  if (input.taxLines) {
    const rates = input.taxLines.map((l) => rateKey(l.ratePercent))
    if (new Set(rates).size !== rates.length) {
      throw new HttpError(422, 'Jeder Steuersatz darf nur einmal vorkommen.', {
        taxLines: 'Steuersatz doppelt.',
      })
    }
    await tx`delete from incoming_invoice_tax where incoming_invoice_id = ${id}`
    for (const [position, line] of input.taxLines.entries()) {
      await tx`
        insert into incoming_invoice_tax (tenant_id, incoming_invoice_id, rate_percent, net_cents, tax_cents, position)
        values (${auth.tenantId}, ${id}, ${line.ratePercent}, ${line.netCents}, ${line.taxCents}, ${position})`
    }
  }
  if (input.allocations) {
    for (const [index, a] of input.allocations.entries()) {
      if ((a.projectId === null) === (a.businessAreaId === null)) {
        throw new HttpError(
          422,
          'Bitte je Zeile genau ein Projekt oder einen Betriebsbereich wählen.',
          {
            [`allocations.${index}`]: 'Projekt oder Betriebsbereich wählen.',
          },
        )
      }
      if (a.projectId) await requireVisibleProject(tx, auth, a.projectId)
      if (a.businessAreaId) {
        const [area] = await tx`select 1 from business_area where id = ${a.businessAreaId}`
        if (!area) throw notFound('Der Betriebsbereich')
      }
    }
    await tx`delete from incoming_invoice_allocation where incoming_invoice_id = ${id}`
    for (const [position, a] of input.allocations.entries()) {
      await tx`
        insert into incoming_invoice_allocation (tenant_id, incoming_invoice_id, project_id, business_area_id,
                                                 cost_type, rate_percent, net_cents, description, position, line_id)
        values (${auth.tenantId}, ${id}, ${a.projectId}, ${a.businessAreaId}, ${a.costType}, ${a.ratePercent},
                ${a.netCents}, ${a.description ?? null}, ${position}, ${a.lineId ?? null})`
    }
  }
}

const COLUMNS: Record<string, string> = {
  documentKind: 'document_kind',
  contactId: 'contact_id',
  supplierName: 'supplier_name',
  supplierVatId: 'supplier_vat_id',
  supplierTaxNumber: 'supplier_tax_number',
  supplierAddress: 'supplier_address',
  supplierIban: 'supplier_iban',
  invoiceNumber: 'invoice_number',
  invoiceDate: 'invoice_date',
  dueDate: 'due_date',
  netCents: 'net_cents',
  taxCents: 'tax_cents',
  grossCents: 'gross_cents',
  reverseCharge: 'reverse_charge',
  note: 'note',
}

function businessAreaOf(row: {
  id: string
  name: string
  sort: number
  archivedAt: Date | null
}): BusinessArea {
  return { id: row.id, name: row.name, sort: row.sort, archived: row.archivedAt !== null }
}

async function uniqueName<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(409, 'Einen Betriebsbereich mit diesem Namen gibt es bereits.', {
        name: 'Name bereits vergeben.',
      })
    }
    throw error
  }
}

/**
 * Receives one file as Eingangsrechnung: type check, e-invoice read + KoSIT (outside the
 * transaction), duplicate check by SHA-256, data prefilled, original stored (WORM). Used by the
 * upload and by the e-mail inbox (P2.4). Returns the id; 409 for a file received before.
 */
export async function ingestIncomingInvoice(
  services: Services,
  auth: { tenantId: string; userId: string | null },
  file: { filename: string; data: Buffer },
  origin: { via: 'upload' | 'email'; from?: string | null; subject?: string | null },
): Promise<string> {
  const filename = sanitizeFilename(file.filename)
  const data = file.data
  const received = receive(filename, data)
  const sha256 = createHash('sha256').update(data).digest()

  const existing = await inTenant(
    services,
    auth,
    (tx) => tx<{ id: string }[]>`select id from incoming_invoice where sha256 = ${sha256}`,
  )
  if (existing[0]) {
    throw new HttpError(409, 'Diese Datei wurde bereits als Eingangsrechnung hochgeladen.', {
      existingId: existing[0].id,
    })
  }
  // Outside the transaction: KoSIT may take a moment.
  const validation = received.xml ? await validate(services, received.xml) : null
  const messages: Messages = [...(validation?.messages ?? [])]
  if (received.unreadable) {
    messages.push({
      level: 'warning',
      code: null,
      text: `Die eingebettete E-Rechnung ist nicht lesbar: ${received.unreadable}`,
    })
  }
  const data0 = prefill(received.einvoice)

  return inTenant(services, auth, async (tx) => {
    const vatId = normalizeVatId(data0?.supplierVatId ?? null)
    const [contact] = vatId
      ? await tx<{ id: string }[]>`
          select id from contact
          where archived_at is null and upper(regexp_replace(vat_id, '[\\s.-]', '', 'g')) = ${vatId}
          order by created_at limit 1`
      : []
    let inserted: { id: string }[]
    try {
      inserted = await tx<{ id: string }[]>`
        insert into incoming_invoice (
          tenant_id, document_kind, source, filename, mime_type, sha256, size_bytes,
          einvoice_profile, einvoice_en16931, einvoice_valid, einvoice_messages, einvoice,
          contact_id, supplier_name, supplier_vat_id, supplier_tax_number, supplier_address, supplier_iban,
          invoice_number, invoice_date, due_date, net_cents, tax_cents, gross_cents, reverse_charge,
          uploaded_by, received_via, email_from, email_subject)
        values (
          ${auth.tenantId}, ${data0?.documentKind ?? 'invoice'}, ${received.source}, ${filename},
          ${received.mime}, ${sha256}, ${data.length},
          ${received.einvoice?.profile.label ?? null}, ${received.einvoice?.profile.en16931 ?? null},
          ${validation?.valid ?? null}, ${tx.json(messages)},
          ${received.einvoice ? tx.json(JSON.parse(JSON.stringify(einvoiceView(received.einvoice)))) : null},
          ${contact?.id ?? null}, ${data0?.supplierName?.slice(0, 200) ?? null},
          ${data0?.supplierVatId?.slice(0, 30) ?? null}, ${data0?.supplierTaxNumber?.slice(0, 30) ?? null},
          ${data0?.supplierAddress?.slice(0, 500) ?? null}, ${data0?.supplierIban ?? null},
          ${data0?.invoiceNumber ?? null}, ${data0?.invoiceDate ?? null}, ${data0?.dueDate ?? null},
          ${data0?.netCents ?? 0n}, ${data0?.taxCents ?? 0n}, ${data0?.grossCents ?? 0n},
          ${data0?.reverseCharge ?? false}, ${auth.userId}, ${origin.via},
          ${origin.from?.slice(0, 300) ?? null}, ${origin.subject?.slice(0, 500) ?? null})
        returning id`
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'Diese Datei wurde bereits als Eingangsrechnung hochgeladen.')
      }
      throw error
    }
    const incomingId = (inserted[0] as { id: string }).id
    for (const [position, line] of (data0?.taxLines ?? []).entries()) {
      await tx`
        insert into incoming_invoice_tax (tenant_id, incoming_invoice_id, rate_percent, net_cents, tax_cents, position)
        values (${auth.tenantId}, ${incomingId}, ${line.ratePercent}, ${line.netCents}, ${line.taxCents}, ${position})
        on conflict (incoming_invoice_id, rate_percent) do nothing`
    }
    await storeIncomingOriginal(tx, services, auth, incomingId, { data, mime: received.mime })
    return incomingId
  })
}

export function registerIncomingInvoiceRoutes(app: FastifyInstance, services: Services) {
  const send = async (
    auth: AuthContext,
    id: string,
    reply: { header: (k: string, v: string) => unknown },
  ) => {
    const loaded = await inTenant(services, auth, (tx) => requireIncoming(tx, auth, id))
    reply.header('etag', etagOf(loaded.updatedAt))
    return loaded.detail
  }

  app.get('/api/v1/incoming-invoices', async (request): Promise<IncomingInvoiceList> => {
    const auth = requirePermission(request, 'incoming_invoice.read')
    const query = parse(incomingListQuery, request.query)
    const cursor = query.cursor ? decodeCursor(query.cursor, 2) : null
    return inTenant(services, auth, async (tx) => {
      const today = todayOf(tx)
      const conditions = [incomingVisibility(tx, auth)]
      if (query.status) conditions.push(tx`i.status = ${query.status}`)
      if (query.payment) {
        conditions.push(tx`i.status = 'confirmed'`)
        if (query.payment === 'paid') conditions.push(tx`i.paid_on is not null`)
        else conditions.push(tx`i.paid_on is null`)
        if (query.payment === 'overdue') {
          conditions.push(tx`i.document_kind = 'invoice' and i.due_date < ${today}::date`)
        }
      }
      if (query.from) conditions.push(tx`i.invoice_date >= ${query.from}`)
      if (query.to) conditions.push(tx`i.invoice_date <= ${query.to}`)
      if (query.projectId) {
        conditions.push(tx`exists (select 1 from incoming_invoice_allocation a
                                   where a.incoming_invoice_id = i.id and a.project_id = ${query.projectId})`)
      }
      if (query.businessAreaId) {
        conditions.push(tx`exists (select 1 from incoming_invoice_allocation a
                                   where a.incoming_invoice_id = i.id and a.business_area_id = ${query.businessAreaId})`)
      }
      if (query.q) {
        const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        conditions.push(
          tx`(i.supplier_name ilike ${like} or i.invoice_number ilike ${like} or i.filename ilike ${like})`,
        )
      }
      if (cursor) {
        conditions.push(
          tx`(coalesce(i.invoice_date, (i.received_at at time zone 'Europe/Berlin')::date), i.id)
              < (${String(cursor[0])}::date, ${String(cursor[1])}::uuid)`,
        )
      }
      const where = conditions.reduce((a, b) => tx`${a} and ${b}`)
      const rows = await tx<Row[]>`
        select ${listColumns(tx)} from incoming_invoice i
        where ${where}
        order by coalesce(i.invoice_date, (i.received_at at time zone 'Europe/Berlin')::date) desc, i.id desc
        limit ${query.limit + 1}`
      const page = rows.slice(0, query.limit)
      const last = page.at(-1)
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from incoming_invoice i where i.status = 'review' and ${incomingVisibility(tx, auth)}`
      return {
        items: page.map((row) => toListItem(row, today)),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor([last.sortDate, last.id]) : null,
        reviewCount: count?.n ?? 0,
      }
    })
  })

  app.post('/api/v1/incoming-invoices', async (request, reply) => {
    const auth = requirePermission(request, 'incoming_invoice.write')
    const body = request.body
    if (!(body instanceof Readable)) {
      throw new HttpError(415, 'Bitte die Datei als application/octet-stream senden.')
    }
    const { filename: rawName } = parse(uploadIncomingQuery, request.query)
    const maxBytes = services.config.UPLOAD_MAX_MB * 1024 * 1024
    const tooLarge = () =>
      new HttpError(413, `Die Datei ist zu groß (höchstens ${services.config.UPLOAD_MAX_MB} MB).`)
    if (Number(request.headers['content-length'] ?? 0) > maxBytes) {
      body.resume()
      throw tooLarge()
    }
    const data = await readBody(body, maxBytes, tooLarge)
    if (!data.length) throw new HttpError(400, 'Die Datei ist leer.')
    const id = await ingestIncomingInvoice(
      services,
      auth,
      { filename: rawName, data },
      {
        via: 'upload',
      },
    )
    reply.status(201)
    return send(auth, id, reply)
  })

  app.get('/api/v1/incoming-invoices/:id', async (request, reply) => {
    const auth = requirePermission(request, 'incoming_invoice.read')
    const { id } = parse(idParam, request.params)
    return send(auth, id, reply)
  })

  /** The received original, unchanged (from the files volume or the WORM archive). */
  app.get('/api/v1/incoming-invoices/:id/original', async (request, reply) => {
    const auth = requirePermission(request, 'incoming_invoice.read')
    const { id } = parse(idParam, request.params)
    const { download } = parse(originalQuery, request.query)
    const row = await inTenant(services, auth, async (tx) => {
      const loaded = await requireIncoming(tx, auth, id)
      const [artifact] = await tx<{ key: string }[]>`
        select storage_key as key from document_artifact where incoming_invoice_id = ${id}`
      return { detail: loaded.detail, key: (artifact as { key: string }).key }
    })
    const stream = await openArtifact(services, row.key)
    if (!stream) {
      request.log.error({ incomingInvoiceId: id }, 'incoming original missing')
      throw new HttpError(500, 'Das Original ist im Speicher nicht vorhanden.')
    }
    const inline = row.detail.inline && download !== 'true'
    return reply
      .header('content-type', row.detail.mimeType)
      .header(
        'content-disposition',
        contentDisposition(inline ? 'inline' : 'attachment', row.detail.filename),
      )
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        row.detail.mimeType === 'application/pdf'
          ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'"
          : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      )
      .send(stream)
  })

  app.patch('/api/v1/incoming-invoices/:id', async (request, reply) => {
    const auth = requirePermission(request, 'incoming_invoice.write')
    const { id } = parse(idParam, request.params)
    const input = parse(updateIncomingRequest, request.body)
    await inTenant(services, auth, async (tx) => {
      const { detail, updatedAt } = await requireIncoming(tx, auth, id)
      checkIfMatch(request.headers['if-match'], updatedAt)
      if (detail.status !== 'review') {
        throw new HttpError(
          409,
          'Die Prüfung ist abgeschlossen; die Rechnung kann nicht mehr geändert werden.',
        )
      }
      if (input.contactId) {
        const [contact] = await tx`select 1 from contact where id = ${input.contactId}`
        if (!contact) throw notFound('Der Kontakt')
      }
      const values: Record<string, unknown> = {}
      for (const [key, column] of Object.entries(COLUMNS)) {
        const value = input[key as keyof UpdateIncomingRequest]
        if (value !== undefined) values[column] = value
      }
      await writeLines(tx, auth, id, input)
      // Always touch the row, so the ETag changes with the lines as well.
      values.updated_at = new Date()
      await tx`update incoming_invoice set ${tx(values)} where id = ${id}`
    })
    return send(auth, id, reply)
  })

  app.post('/api/v1/incoming-invoices/:id/confirm', async (request, reply) => {
    const auth = requirePermission(request, 'incoming_invoice.write')
    const { id } = parse(idParam, request.params)
    await inTenant(services, auth, async (tx) => {
      const { detail } = await requireIncoming(tx, auth, id)
      if (detail.status !== 'review') {
        throw new HttpError(409, 'Die Prüfung dieser Rechnung ist bereits abgeschlossen.')
      }
      if (detail.problems.length) {
        throw new HttpError(
          422,
          'Die Prüfung kann noch nicht bestätigt werden.',
          Object.fromEntries(detail.problems.map((p) => [p.field, p.message])),
        )
      }
      // Kreditorennummer aus dem Nummernkreis, if the company wants it (Einstellungen › DATEV).
      if (
        detail.contactId &&
        (await datevSettings(tx)).autoCreditorNumbers &&
        (await usableContact(tx, detail.contactId))
      ) {
        await assignCreditorNumber(tx, detail.contactId)
      }
      await tx`
        update incoming_invoice set status = 'confirmed', confirmed_at = now(), confirmed_by = ${auth.userId}
        where id = ${id}`
    })
    return send(auth, id, reply)
  })

  app.post('/api/v1/incoming-invoices/:id/discard', async (request, reply) => {
    const auth = requirePermission(request, 'incoming_invoice.write')
    const { id } = parse(idParam, request.params)
    const { reason } = parse(closeIncomingRequest, request.body)
    await inTenant(services, auth, async (tx) => {
      const { detail } = await requireIncoming(tx, auth, id)
      if (detail.status !== 'review') {
        throw new HttpError(
          409,
          'Nur Rechnungen in Prüfung können verworfen werden; bestätigte bitte stornieren.',
        )
      }
      await tx`
        update incoming_invoice set status = 'discarded', closed_at = now(), closed_by = ${auth.userId},
               close_reason = ${reason}
        where id = ${id}`
    })
    return send(auth, id, reply)
  })

  app.post('/api/v1/incoming-invoices/:id/cancel', async (request, reply) => {
    const auth = requirePermission(request, 'incoming_invoice.write')
    const { id } = parse(idParam, request.params)
    const { reason } = parse(closeIncomingRequest, request.body)
    await inTenant(services, auth, async (tx) => {
      const { detail } = await requireIncoming(tx, auth, id)
      if (detail.status !== 'confirmed') {
        throw new HttpError(409, 'Nur bestätigte Rechnungen können storniert werden.')
      }
      await tx`
        update incoming_invoice set status = 'cancelled', closed_at = now(), closed_by = ${auth.userId},
               close_reason = ${reason}
        where id = ${id}`
    })
    return send(auth, id, reply)
  })

  app.post('/api/v1/incoming-invoices/:id/payment', async (request, reply) => {
    const auth = requirePermission(request, 'incoming_invoice.write')
    const { id } = parse(idParam, request.params)
    const input = parse(incomingPaymentRequest, request.body)
    await inTenant(services, auth, async (tx) => {
      const { detail } = await requireIncoming(tx, auth, id)
      if (detail.status !== 'confirmed') {
        throw new HttpError(409, 'Der Zahlstatus kann erst nach der Prüfung gesetzt werden.')
      }
      if (input.paidOn && input.paidOn > todayOf(tx)) {
        throw new HttpError(422, 'Das Zahldatum liegt in der Zukunft.', { paidOn: 'Datum prüfen.' })
      }
      await tx`
        update incoming_invoice set paid_on = ${input.paidOn}, payment_note = ${input.note ?? null}
        where id = ${id}`
    })
    return send(auth, id, reply)
  })

  // ---- Betriebsbereiche --------------------------------------------------------------------

  app.get('/api/v1/business-areas', async (request): Promise<BusinessArea[]> => {
    const auth = requireAuth(request)
    if (!auth.permissions.has('incoming_invoice.read') && !auth.permissions.has('settings.read')) {
      throw forbidden()
    }
    const rows = await inTenant(
      services,
      auth,
      (tx) => tx<{ id: string; name: string; sort: number; archivedAt: Date | null }[]>`
        select id, name, sort, archived_at as "archivedAt" from business_area order by sort, name`,
    )
    return rows.map(businessAreaOf)
  })

  app.post('/api/v1/business-areas', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(createBusinessAreaRequest, request.body)
    const row = await uniqueName(() =>
      inTenant(services, auth, async (tx) => {
        const [created] = await tx<
          { id: string; name: string; sort: number; archivedAt: Date | null }[]
        >`
          insert into business_area (tenant_id, name, sort)
          values (${auth.tenantId}, ${input.name},
                  coalesce(${input.sort ?? null}::int, (select coalesce(max(sort), 0) + 10 from business_area)))
          returning id, name, sort, archived_at as "archivedAt"`
        return created
      }),
    )
    reply.status(201)
    return businessAreaOf(
      row as { id: string; name: string; sort: number; archivedAt: Date | null },
    )
  })

  app.patch('/api/v1/business-areas/:id', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(idParam, request.params)
    const input = parse(updateBusinessAreaRequest, request.body)
    const row = await uniqueName(() =>
      inTenant(services, auth, async (tx) => {
        const values: Record<string, unknown> = { updated_at: new Date() }
        if (input.name !== undefined) values.name = input.name
        if (input.sort !== undefined) values.sort = input.sort
        if (input.archived !== undefined) {
          values.archived_at = input.archived ? new Date() : null
        }
        const [updated] = await tx<
          { id: string; name: string; sort: number; archivedAt: Date | null }[]
        >`
          update business_area set ${tx(values)} where id = ${id}
          returning id, name, sort, archived_at as "archivedAt"`
        return updated
      }),
    )
    if (!row) throw notFound('Der Betriebsbereich')
    return businessAreaOf(row)
  })
}
