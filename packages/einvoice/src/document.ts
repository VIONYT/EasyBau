import type { DocumentDetail, DocumentItem, EinvoiceFormat } from '@easybau/schemas'
import { Decimal } from 'decimal.js'
import { decimal } from './format.js'
import type {
  EinvoiceAllowanceCharge,
  EinvoiceLine,
  EinvoiceModel,
  EinvoiceParty,
  ElectronicAddress,
  InvoiceTypeCode,
  VatCategory,
} from './model.js'

export interface EinvoiceContext {
  /** Unit id → UN/ECE Rec. 20/21 code (BT-130). */
  unitCodes: ReadonlyMap<string, string>
  /** Storno: date of the cancelled invoice (BG-3, BT-26). */
  cancelledInvoiceDate?: string | null
}

export interface EinvoiceProblem {
  /** Field of the finalize check (company, contactId, items …). */
  field: string
  message: string
}

const COUNTED = new Set(['item', 'lump_sum'])

const MODE_CATEGORY: Record<string, VatCategory> = {
  reverse_charge_13b: 'AE',
  small_business: 'E',
  intra_eu: 'K',
  export: 'G',
}

/** VATEX codes (BT-121) for the exempt categories. */
const EXEMPTION_CODES: Partial<Record<VatCategory, string>> = {
  AE: 'VATEX-EU-AE',
  K: 'VATEX-EU-IC',
  G: 'VATEX-EU-G',
}

/** Leitweg-ID: Grobadressierung, optional Feinadressierung, Prüfziffer (e.g. 04011000-12345-67). */
const LEITWEG_ID = /^\d{2,12}(-[A-Za-z0-9]{1,30})?-\d{2}$/

export const isLeitwegId = (value: string | null | undefined): boolean =>
  !!value && LEITWEG_ID.test(value.trim())

/**
 * Formats a finalized invoice is issued in: always ZUGFeRD (EN 16931, embedded in the PDF/A-3),
 * plus XRechnung when the customer wants it or has a Leitweg-ID (public authority).
 */
export function einvoiceFormatsOf(recipient: DocumentDetail['recipient']): EinvoiceFormat[] {
  const formats: EinvoiceFormat[] = ['zugferd']
  const preferred = recipient?.einvoiceFormat ?? null
  if (preferred === 'xrechnung_ubl' || preferred === 'xrechnung_cii') formats.push(preferred)
  else if (!preferred && isLeitwegId(recipient?.buyerReference)) formats.push('xrechnung_ubl')
  return formats
}

/** Document types that are issued as e-invoice. */
export const isEinvoiceDocument = (doc: Pick<DocumentDetail, 'type'>): boolean =>
  doc.type === 'invoice' || doc.type === 'credit_note'

function typeCodeOf(doc: DocumentDetail): InvoiceTypeCode {
  if (doc.type === 'credit_note') return '381'
  switch (doc.invoiceKind) {
    case 'cancellation':
      return '384'
    case 'progress':
      return '875'
    case 'final':
      return '877'
    case 'partial':
      return '326'
    default:
      return '380'
  }
}

/** Prerequisites beyond § 14 UStG (EN 16931, XRechnung) — checked before a number is drawn. */
export function einvoiceProblems(
  doc: DocumentDetail,
  ctx: EinvoiceContext,
  formats: readonly EinvoiceFormat[] = einvoiceFormatsOf(doc.recipient),
): EinvoiceProblem[] {
  const problems: EinvoiceProblem[] = []
  const issuer = doc.issuer
  const data = issuer.einvoice
  const recipient = doc.recipient
  // Firma address and an empty recipient are already reported by the § 14 check.
  if (recipient?.lines.length && (!recipient.address?.postalCode || !recipient.address.city)) {
    problems.push({
      field: 'contactId',
      message: 'E-Rechnung: PLZ und Ort des Empfängers fehlen (Kontakt › Adresse).',
    })
  }
  for (const item of doc.items) {
    if (!COUNTED.has(item.positionType) || !item.unit) continue
    if (!ctx.unitCodes.get(item.unit.id)) {
      problems.push({
        field: 'items',
        message: `E-Rechnung: Für die Einheit „${item.unit.symbol}“ fehlt der UN/ECE-Code.`,
      })
    }
  }
  if (doc.taxMode === 'reverse_charge_13b' && !recipient?.vatId) {
    problems.push({
      field: 'contactId',
      message:
        'E-Rechnung: Bei § 13b UStG braucht der Empfänger eine USt-IdNr. (Kontakt › Steuer).',
    })
  }
  if (doc.taxMode === 'intra_eu' && !data?.vatId) {
    problems.push({
      field: 'company',
      message:
        'E-Rechnung: Für eine innergemeinschaftliche Leistung braucht Ihre Firma eine USt-IdNr.',
    })
  }
  if (formats.some((f) => f.startsWith('xrechnung'))) {
    if (!data?.email || !data.phone) {
      problems.push({
        field: 'company',
        message:
          'XRechnung: E-Mail-Adresse und Telefonnummer Ihrer Firma fehlen (Einstellungen › Firma).',
      })
    }
    if (!data?.iban) {
      problems.push({
        field: 'company',
        message: 'XRechnung: Die Bankverbindung (IBAN) Ihrer Firma fehlt (Einstellungen › Firma).',
      })
    }
    if (!isLeitwegId(recipient?.buyerReference) && !recipient?.einvoiceEmail) {
      problems.push({
        field: 'contactId',
        message:
          'XRechnung: Leitweg-ID oder E-Mail-Adresse für E-Rechnungen des Empfängers fehlt (Kontakt › E-Rechnung).',
      })
    }
  }
  return problems
}

const minus = (cents: bigint) => (cents < 0n ? -cents : cents)

function lineVat(doc: DocumentDetail, item: DocumentItem): { category: VatCategory; rate: string } {
  const exempt = MODE_CATEGORY[doc.taxMode]
  if (exempt) return { category: exempt, rate: '0' }
  const rate = item.taxRatePercent ?? '0'
  const match = doc.totals.taxLines.find((t) => new Decimal(t.ratePercent).eq(rate))
  if (match) return { category: match.category as VatCategory, rate }
  return { category: new Decimal(rate).isZero() ? 'Z' : 'S', rate }
}

function linesOf(doc: DocumentDetail, ctx: EinvoiceContext): EinvoiceLine[] {
  const counted = doc.items.filter((i) => COUNTED.has(i.positionType))
  const ozs = counted.map((i) => i.oz?.trim() ?? '')
  const ozUnique = ozs.every((oz) => oz) && new Set(ozs).size === ozs.length
  return counted.map((item, index) => {
    let quantity = new Decimal(item.quantity ?? '1')
    const netCents = BigInt(item.totalCents ?? 0)
    // Unit price in euros; without one (price entered as total) it is derived from the total.
    let price =
      item.unitPriceCents !== null
        ? new Decimal(item.unitPriceCents).div(100)
        : quantity.isZero()
          ? new Decimal(netCents.toString()).div(100)
          : new Decimal(netCents.toString()).div(100).div(quantity)
    // BR-27: prices are never negative; the sign belongs to the quantity (Storno, Gutschrift).
    if (price.isNegative()) {
      price = price.neg()
      quantity = quantity.neg()
    }
    const discount = item.discountPercent ? new Decimal(item.discountPercent) : null
    const hasDiscount = discount && !discount.isZero()
    const netPrice = hasDiscount
      ? price.mul(new Decimal(100).minus(discount).div(100)).toDecimalPlaces(4)
      : price.toDecimalPlaces(4)
    const vat = lineVat(doc, item)
    const unitCode = item.unit
      ? (ctx.unitCodes.get(item.unit.id) ?? 'C62')
      : item.positionType === 'lump_sum'
        ? 'LS'
        : 'C62'
    const name = item.shortText?.trim() || item.longText?.trim().split('\n')[0] || 'Position'
    return {
      id: ozUnique ? (ozs[index] as string) : String(index + 1),
      name,
      description: item.longText?.trim() || null,
      quantity: decimal(quantity),
      unitCode,
      netPrice: decimal(netPrice),
      grossPrice: hasDiscount ? decimal(price) : null,
      priceDiscount: hasDiscount ? decimal(price.minus(netPrice)) : null,
      netCents,
      vatCategory: vat.category,
      vatRate: vat.rate,
    }
  })
}

function allowancesOf(doc: DocumentDetail): EinvoiceAllowanceCharge[] {
  const result: EinvoiceAllowanceCharge[] = []
  const deducted = doc.totals.deductions
    .map((d) => d.number)
    .filter(Boolean)
    .join(', ')
  for (const line of doc.totals.taxLines) {
    const vat = { vatCategory: line.category as VatCategory, vatRate: line.ratePercent }
    const discount = BigInt(line.discountCents)
    if (discount !== 0n) {
      const pct = doc.discountPercent
        ? ` ${decimal(doc.discountPercent, 2).replace('.', ',')} %`
        : ''
      result.push({
        charge: discount < 0n,
        amountCents: minus(discount),
        reason: discount < 0n ? `Storno Nachlass${pct}` : `Nachlass${pct}`,
        reasonCode: discount < 0n ? null : '95',
        ...vat,
      })
    }
    const deduction = BigInt(line.deductedNetCents)
    if (deduction !== 0n) {
      const reason = `Abzug bereits abgerechneter Leistungen${deducted ? ` (${deducted})` : ''}`
      result.push({
        charge: deduction < 0n,
        amountCents: minus(deduction),
        reason: deduction < 0n ? `Storno: ${reason}` : reason,
        reasonCode: null,
        ...vat,
      })
    }
  }
  return result
}

function electronicAddressOf(
  recipient: NonNullable<DocumentDetail['recipient']>,
): ElectronicAddress | null {
  if (isLeitwegId(recipient.buyerReference)) {
    return { scheme: '0204', value: (recipient.buyerReference as string).trim() }
  }
  if (recipient.einvoiceEmail) return { scheme: 'EM', value: recipient.einvoiceEmail.trim() }
  return null
}

const germanDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
const euro = (cents: number) =>
  `${(cents / 100)
    .toFixed(2)
    .replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`

function paymentTerms(doc: DocumentDetail): string | null {
  const parts: string[] = []
  if (doc.dueDate) parts.push(`Zahlbar ohne Abzug bis ${germanDate(doc.dueDate)}.`)
  if (doc.cashDiscountPercent && doc.cashDiscountDays !== null && doc.totals.grossCents > 0) {
    // XRechnung format for Skonto (BR-DE-18): own line, closed by a line break.
    parts.push(
      `#SKONTO#TAGE=${doc.cashDiscountDays}#PROZENT=${new Decimal(doc.cashDiscountPercent).toFixed(2)}#\n`,
    )
  }
  return parts.length ? parts.join('\n') : null
}

function notesOf(doc: DocumentDetail): string[] {
  const notes: string[] = []
  if (doc.subject?.trim()) notes.push(doc.subject.trim())
  if (doc.invoiceKind === 'cancellation' && doc.cancels?.number) {
    notes.push(
      `Stornorechnung zu Rechnung ${doc.cancels.number}${doc.cancelReason ? `. Grund: ${doc.cancelReason}` : ''}.`,
    )
  }
  if (doc.totals.deductions.length) {
    notes.push(
      `Abgezogen: ${doc.totals.deductions
        .map(
          (d) => `${d.number ?? '–'} vom ${germanDate(d.documentDate)} (netto ${euro(d.netCents)})`,
        )
        .join('; ')}.`,
    )
  }
  const { retentionCents, constructionLevyCents, payableCents } = doc.totals
  if (retentionCents || constructionLevyCents) {
    const items = [
      retentionCents
        ? `Sicherheitseinbehalt ${decimal(doc.retentionPercent ?? '0', 2).replace('.', ',')} %: ${euro(retentionCents)}`
        : null,
      constructionLevyCents
        ? `Bauumlage ${decimal(doc.constructionLevyPercent ?? '0', 2).replace('.', ',')} %: ${euro(constructionLevyCents)}`
        : null,
    ].filter(Boolean)
    notes.push(`${items.join(', ')}. Auszahlungsbetrag: ${euro(payableCents)}.`)
  }
  for (const note of doc.legalNotes) if (note.trim()) notes.push(note.trim())
  return notes
}

/**
 * EN 16931 model of a finalized invoice. Reads only the document and its snapshots (rule 4):
 * Firma and Empfänger as frozen at Festschreiben, amounts as calculated by the domain.
 */
export function einvoiceFromDocument(
  doc: DocumentDetail,
  ctx: EinvoiceContext,
  format: EinvoiceFormat,
): EinvoiceModel {
  if (!doc.number) throw new Error('Only finalized documents become e-invoices.')
  const recipient = doc.recipient
  if (!recipient?.address || !doc.issuer.address) {
    throw new Error('The document has no structured addresses (finalized before e-invoicing).')
  }
  const data = doc.issuer.einvoice
  const xrechnung = format !== 'zugferd'
  const lines = linesOf(doc, ctx)
  const allowancesCharges = allowancesOf(doc)
  const sum = (charge: boolean) =>
    allowancesCharges.filter((a) => a.charge === charge).reduce((s, a) => s + a.amountCents, 0n)

  const start = doc.serviceFrom ?? doc.serviceTo
  const end = doc.serviceTo ?? doc.serviceFrom
  const sameDay = start && start === end

  const seller: EinvoiceParty = {
    name: doc.issuer.name,
    // BR-CO-26: without USt-IdNr. the Steuernummer identifies the seller (BT-29).
    id: data?.vatId ? null : (data?.taxNumber ?? null),
    address: doc.issuer.address,
    vatId: data?.vatId ?? null,
    taxNumber: data?.taxNumber ?? null,
    electronicAddress: data?.email ? { scheme: 'EM', value: data.email } : null,
    contact:
      data?.email || data?.phone
        ? { name: data.contactName ?? doc.issuer.name, phone: data.phone, email: data.email }
        : null,
  }
  const buyer: EinvoiceParty = {
    name: recipient.name,
    id: recipient.customerNumber ?? null,
    address: recipient.address,
    vatId: recipient.vatId ?? null,
    taxNumber: null,
    electronicAddress: electronicAddressOf(recipient),
    contact: null,
  }

  const preceding =
    doc.invoiceKind === 'cancellation' && doc.cancels?.number
      ? [{ number: doc.cancels.number, date: ctx.cancelledInvoiceDate ?? null }]
      : doc.totals.deductions
          .filter((d) => d.number)
          .map((d) => ({ number: d.number as string, date: d.documentDate }))

  // BT-10 is mandatory in XRechnung: Leitweg-ID, otherwise the customer's own reference.
  const buyerReference =
    recipient.buyerReference?.trim() ||
    (xrechnung ? recipient.customerNumber || doc.project.number || doc.number : null)

  return {
    number: doc.number,
    issueDate: doc.documentDate,
    typeCode: typeCodeOf(doc),
    currency: 'EUR',
    dueDate: doc.dueDate,
    buyerReference,
    project: { id: doc.project.number ?? doc.project.name, name: doc.project.name },
    notes: notesOf(doc),
    period: start && end && !sameDay ? { start, end } : null,
    deliveryDate: sameDay ? start : null,
    deliveryCountry: doc.taxMode === 'intra_eu' ? recipient.address.countryCode : null,
    precedingInvoices: preceding,
    seller,
    buyer,
    payment: {
      meansCode: data?.iban ? '58' : '1',
      reference: doc.number,
      iban: data?.iban ?? null,
      bic: data?.bic ?? null,
      accountName: data?.iban ? doc.issuer.name : null,
      terms: paymentTerms(doc),
    },
    lines,
    allowancesCharges,
    vatBreakdown: doc.totals.taxLines.map((t) => ({
      category: t.category as VatCategory,
      rate: t.ratePercent,
      baseCents: BigInt(t.netCents),
      taxCents: BigInt(t.taxCents),
      exemptionReason: t.exemptionReason,
      exemptionCode: EXEMPTION_CODES[t.category as VatCategory] ?? null,
    })),
    totals: {
      lineNetCents: lines.reduce((s, l) => s + l.netCents, 0n),
      allowanceCents: sum(false),
      chargeCents: sum(true),
      netCents: BigInt(doc.totals.netCents),
      taxCents: BigInt(doc.totals.taxCents),
      grossCents: BigInt(doc.totals.grossCents),
      dueCents: BigInt(doc.totals.grossCents),
    },
  }
}
