import { csvField, germanAmount } from './csv.js'

/**
 * DATEV-Format „Buchungsstapel“ (EXTF, Version 700, Kategorie 21) for the tax advisor.
 * Revenue accounts are DATEV "Automatikkonten" (e.g. SKR03 8400 = 19 %), so no BU-Schlüssel is
 * written; the advisor's import must confirm the account mapping (see Einstellungen › DATEV).
 */

export interface DatevHeader {
  consultantNumber: string
  clientNumber: string
  /** Start of the fiscal year, ISO date. */
  fiscalYearStart: string
  accountLength: number
  from: string
  to: string
  description: string
  createdAt: Date
}

export interface DatevBooking {
  /** Amount in cents; the sign decides Soll/Haben. */
  amountCents: bigint
  account: string
  contraAccount: string
  /** ISO date of the document. */
  date: string
  documentNo: string
  text: string
  /** BU-Schlüssel, e.g. "9" (19 % Vorsteuer); empty for Automatikkonten. */
  taxKey?: string
}

export interface DatevAccounts {
  standard19: string
  reduced7: string
  reverseCharge: string
  exempt: string
  bank: string
}

export interface ExportInvoice {
  number: string
  date: string
  customerAccount: string
  customerName: string
  taxLines: { category: string; ratePercent: string; netCents: bigint; taxCents: bigint }[]
}

export interface ExportPayment {
  invoiceNumber: string
  date: string
  amountCents: bigint
  customerAccount: string
  customerName: string
}

/**
 * Accepted Kürzung (Rabatt, Minderung, sonstiger Abzug) on an invoice: reduces revenue and VAT
 * (§ 17 UStG), so it goes to the advisor. Skonto, Einbehalt and Bauumlage are not exported.
 * Positive = reduction, negative = its Gegenbuchung.
 */
export interface ExportAdjustment {
  invoiceNumber: string
  date: string
  /** Gross amount in cents. */
  amountCents: bigint
  customerAccount: string
  customerName: string
  /** Gegenbuchung of an earlier Kürzung. */
  reversal?: boolean
  /** Tax lines of the invoice; the amount is split over them by gross share. */
  taxLines: ExportInvoice['taxLines']
}

const COLUMNS = [
  'Umsatz (ohne Soll/Haben-Kz)',
  'Soll/Haben-Kennzeichen',
  'WKZ Umsatz',
  'Kurs',
  'Basis-Umsatz',
  'WKZ Basis-Umsatz',
  'Konto',
  'Gegenkonto (ohne BU-Schlüssel)',
  'BU-Schlüssel',
  'Belegdatum',
  'Belegfeld 1',
  'Belegfeld 2',
  'Skonto',
  'Buchungstext',
]

const compact = (iso: string) => iso.slice(0, 10).replace(/-/g, '')
const text = (value: string, max: number) => csvField(value.slice(0, max), true)

/** Revenue account of a tax line (category S with 19 % / 7 %, AE = § 13b, others tax-free). */
export function revenueAccount(
  line: { category: string; ratePercent: string },
  accounts: DatevAccounts,
): string {
  if (line.category === 'AE') return accounts.reverseCharge
  if (line.category === 'S')
    return Number(line.ratePercent) >= 19 ? accounts.standard19 : accounts.reduced7
  return accounts.exempt
}

/**
 * Splits `amount` over `weights` proportionally (largest remainder), so the parts add up exactly.
 * Without any weight the whole amount goes to the first part.
 */
export function splitByWeights(amount: bigint, weights: readonly bigint[]): bigint[] {
  const abs = (v: bigint) => (v < 0n ? -v : v)
  const total = weights.reduce((sum, w) => sum + abs(w), 0n)
  if (!weights.length) return []
  if (total === 0n) return weights.map((_, i) => (i === 0 ? amount : 0n))
  const sign = amount < 0n ? -1n : 1n
  const value = abs(amount)
  const parts = weights.map((w) => (value * abs(w)) / total)
  const order = weights
    .map((w, i) => ({ i, rest: (value * abs(w)) % total }))
    .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.i - b.i))
  let left = value - parts.reduce((sum, p) => sum + p, 0n)
  for (const { i } of order) {
    if (left === 0n) break
    parts[i] = (parts[i] as bigint) + 1n
    left -= 1n
  }
  return parts.map((p) => p * sign)
}

/**
 * One booking per invoice and tax rate (Debitor an Erlöse), one per payment (Bank an Debitor) and
 * one per Kürzung and tax rate (Erlöse an Debitor, on the Automatikkonto so the VAT is corrected).
 */
export function datevBookings(
  invoices: readonly ExportInvoice[],
  payments: readonly ExportPayment[],
  accounts: DatevAccounts,
  adjustments: readonly ExportAdjustment[] = [],
): DatevBooking[] {
  const bookings: DatevBooking[] = []
  for (const invoice of invoices) {
    for (const line of invoice.taxLines) {
      bookings.push({
        amountCents: line.netCents + line.taxCents,
        account: invoice.customerAccount,
        contraAccount: revenueAccount(line, accounts),
        date: invoice.date,
        documentNo: invoice.number,
        text: invoice.customerName,
      })
    }
  }
  for (const payment of payments) {
    bookings.push({
      amountCents: payment.amountCents,
      account: accounts.bank,
      contraAccount: payment.customerAccount,
      date: payment.date,
      documentNo: payment.invoiceNumber,
      text: `Zahlung ${payment.customerName}`,
    })
  }
  for (const adjustment of adjustments) {
    const lines = adjustment.taxLines.length
      ? adjustment.taxLines
      : [{ category: 'S', ratePercent: '19.00', netCents: 0n, taxCents: 0n }]
    const parts = splitByWeights(
      adjustment.amountCents,
      lines.map((l) => l.netCents + l.taxCents),
    )
    lines.forEach((line, i) => {
      bookings.push({
        amountCents: parts[i] as bigint,
        account: revenueAccount(line, accounts),
        contraAccount: adjustment.customerAccount,
        date: adjustment.date,
        documentNo: adjustment.invoiceNumber,
        text: `${adjustment.reversal ? 'Storno Kürzung' : 'Kürzung'} ${adjustment.customerName}`,
      })
    })
  }
  return bookings.filter((b) => b.amountCents !== 0n)
}

/** Accounts for received invoices (Eingangsrechnungen): expense per cost type, creditor, bank. */
export interface IncomingAccounts {
  material: string
  labor: string
  equipment: string
  subcontract: string
  other: string
  /** § 13b: Automatikkonto with input and output tax (e.g. SKR03 3120, SKR04 5920). */
  reverseCharge: string
  /** Kreditor (Sammelkreditor), e.g. 70000. */
  creditor: string
  bank: string
}

export interface ExportIncoming {
  invoiceNumber: string
  date: string
  supplierName: string
  creditNote: boolean
  reverseCharge: boolean
  /** Kreditorennummer of the supplier; otherwise the Sammelkreditor. */
  creditorAccount?: string | null
  allocations: {
    costType: 'material' | 'labor' | 'equipment' | 'subcontract' | 'other'
    ratePercent: string
    netCents: bigint
    taxCents: bigint
  }[]
}

export interface ExportIncomingPayment {
  invoiceNumber: string
  date: string
  supplierName: string
  /** Gross amount; negative for credit notes. */
  amountCents: bigint
  creditorAccount?: string | null
}

/** DATEV BU-Schlüssel for input tax: 9 = 19 % Vorsteuer, 8 = 7 % Vorsteuer, none for 0 %. */
export function inputTaxKey(ratePercent: string): string | undefined {
  const rate = Number(ratePercent)
  if (rate >= 19) return '9'
  if (rate > 0) return '8'
  return undefined
}

/**
 * Received invoices: one booking per cost allocation (Aufwand an Kreditor, gross, with the
 * BU-Schlüssel of the input tax; § 13b on its Automatikkonto without key), one per payment
 * (Kreditor an Bank). Credit notes are negative (Haben).
 */
export function incomingBookings(
  invoices: readonly ExportIncoming[],
  payments: readonly ExportIncomingPayment[],
  accounts: IncomingAccounts,
): DatevBooking[] {
  const bookings: DatevBooking[] = []
  for (const invoice of invoices) {
    const sign = invoice.creditNote ? -1n : 1n
    for (const allocation of invoice.allocations) {
      const taxKey = invoice.reverseCharge ? undefined : inputTaxKey(allocation.ratePercent)
      bookings.push({
        amountCents: (allocation.netCents + allocation.taxCents) * sign,
        account: invoice.reverseCharge ? accounts.reverseCharge : accounts[allocation.costType],
        contraAccount: invoice.creditorAccount || accounts.creditor,
        date: invoice.date,
        documentNo: invoice.invoiceNumber,
        text: invoice.supplierName,
        ...(taxKey ? { taxKey } : {}),
      })
    }
  }
  for (const payment of payments) {
    bookings.push({
      amountCents: payment.amountCents,
      account: payment.creditorAccount || accounts.creditor,
      contraAccount: accounts.bank,
      date: payment.date,
      documentNo: payment.invoiceNumber,
      text: `Zahlung ${payment.supplierName}`,
    })
  }
  return bookings.filter((b) => b.amountCents !== 0n)
}

/** The EXTF file as text (CRLF); encode as Windows-1252 before sending. */
export function datevBookingBatch(header: DatevHeader, bookings: readonly DatevBooking[]): string {
  const created = header.createdAt
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 17)
  const head = [
    '"EXTF"',
    '700',
    '21',
    '"Buchungsstapel"',
    '13',
    created,
    '',
    '"RE"',
    '""',
    '""',
    header.consultantNumber,
    header.clientNumber,
    compact(header.fiscalYearStart),
    String(header.accountLength),
    compact(header.from),
    compact(header.to),
    text(header.description, 30),
    '""',
    '1',
    '0',
    '0',
    '"EUR"',
    '',
    '""',
    '',
    '',
    '""',
    '',
    '',
    '""',
    '""',
  ].join(';')
  const rows = bookings.map((b) => {
    const [, month, day] = b.date.slice(0, 10).split('-')
    return [
      germanAmount(b.amountCents < 0n ? -b.amountCents : b.amountCents),
      csvField(b.amountCents < 0n ? 'H' : 'S', true),
      csvField('EUR', true),
      '',
      '',
      '',
      b.account,
      b.contraAccount,
      b.taxKey ? csvField(b.taxKey, true) : '',
      `${day}${month}`,
      text(b.documentNo, 36),
      '""',
      '',
      text(b.text, 60),
    ].join(';')
  })
  return `${[head, COLUMNS.map((c) => csvField(c, true)).join(';'), ...rows].join('\r\n')}\r\n`
}

/** Debitor account from the customer number (K-10001 → 10001); fallback 10000 (Sammeldebitor). */
export function customerAccount(customerNumber: string | null | undefined): string {
  const digits = (customerNumber ?? '').replace(/\D/g, '')
  return digits || '10000'
}

/** First day of the fiscal year containing `date` (ISO) for a start month (1–12). */
export function fiscalYearStart(date: string, startMonth: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number]
  const year = m >= startMonth ? y : y - 1
  return `${year}-${String(startMonth).padStart(2, '0')}-01`
}
