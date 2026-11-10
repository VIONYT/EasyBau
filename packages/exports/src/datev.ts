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

/** One booking per invoice and tax rate (Debitor an Erlöse), one per payment (Bank an Debitor). */
export function datevBookings(
  invoices: readonly ExportInvoice[],
  payments: readonly ExportPayment[],
  accounts: DatevAccounts,
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
      '',
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
