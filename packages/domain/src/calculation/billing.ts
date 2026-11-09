import { Decimal, type NumericInput, toDecimal } from '../decimal.js'
import type { TaxMode } from './document.js'

/**
 * Rechnungsstellung im Bau: Mengenfortschreibung aus dem Leistungsaufmaß, Abschlagslogik,
 * Pflichtangaben (§ 14 Abs. 4 UStG) und Pflichthinweise. Pure functions, no I/O.
 */

export type InvoiceKind = 'standard' | 'partial' | 'progress' | 'final' | 'cancellation'
export type ProgressBillingMode = 'cumulative' | 'individual'

/**
 * Does the invoice show the total performance to date and deduct earlier invoices?
 * Schlussrechnung always; Abschlagsrechnung in the cumulative mode (DESIGN.md §4.1).
 */
export function isCumulativeInvoice(kind: InvoiceKind, mode: ProgressBillingMode | null): boolean {
  return kind === 'final' || (kind === 'progress' && mode !== 'individual')
}

/** Earlier invoices that cumulative invoices deduct and whose quantities count as billed. */
export const DEDUCTED_INVOICE_KINDS: ReadonlySet<InvoiceKind> = new Set(['progress', 'partial'])

/**
 * Mengenfortschreibung: quantity to bill for a position.
 * cumulative invoice → measured to date (earlier invoices are deducted in money);
 * otherwise → measured to date − already billed.
 */
export function billingQuantity(input: {
  measured: NumericInput
  previouslyBilled: NumericInput
  cumulative: boolean
}): Decimal {
  const measured = toDecimal(input.measured)
  return input.cumulative ? measured : measured.minus(toDecimal(input.previouslyBilled))
}

/** Quantity an invoice added to the billed quantity of a position (for later invoices). */
export function contributedQuantity(input: {
  quantity: NumericInput
  previouslyBilled: NumericInput | null
  cumulative: boolean
}): Decimal {
  const quantity = toDecimal(input.quantity)
  if (!input.cumulative) return quantity
  return quantity.minus(toDecimal(input.previouslyBilled ?? 0))
}

/** Adds days to an ISO date (YYYY-MM-DD) without time zones. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** 2026-11-09 → 09.11.2026 */
export function germanDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-')
  return `${d}.${m}.${y}`
}

/** 123456n → "1.234,56 €" (German format, independent of the runtime locale). */
export function formatEuro(cents: bigint): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const euros = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const rest = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${euros},${rest} €`
}

// ---- Pflichtangaben (§ 14 Abs. 4 UStG) ----------------------------------------------------------

export interface InvoiceRequirementsInput {
  issuer: {
    name: string
    street: string | null
    postalCode: string | null
    city: string | null
    taxNumber: string | null
    vatId: string | null
  }
  recipient: { name: string; lines: readonly string[] } | null
  /** USt-IdNr. of the recipient (required for intra-EU supplies). */
  recipientVatId: string | null
  documentDate: string
  serviceFrom: string | null
  serviceTo: string | null
  /** Positions with quantity, unit and text (item, lump sum). */
  pricedItemCount: number
  taxMode: TaxMode
}

export interface Requirement {
  /** Field to point the user to (UI), e.g. "serviceFrom" or "company". */
  field: string
  message: string
}

/** Missing mandatory invoice data (§ 14 Abs. 4 UStG) as German messages; empty = complete. */
export function checkInvoiceRequirements(input: InvoiceRequirementsInput): Requirement[] {
  const problems: Requirement[] = []
  const { issuer } = input
  if (!issuer.name.trim() || !issuer.street || !issuer.postalCode || !issuer.city) {
    problems.push({
      field: 'company',
      message: 'Name und vollständige Anschrift Ihrer Firma fehlen (Einstellungen › Firma).',
    })
  }
  if (!issuer.taxNumber && !issuer.vatId) {
    problems.push({
      field: 'company',
      message: 'Steuernummer oder USt-IdNr. Ihrer Firma fehlt (Einstellungen › Firma).',
    })
  }
  if (!input.recipient?.name.trim() || input.recipient.lines.length === 0) {
    problems.push({
      field: 'contactId',
      message: 'Empfänger mit vollständiger Anschrift fehlt.',
    })
  }
  if (input.taxMode === 'intra_eu' && !input.recipientVatId) {
    problems.push({
      field: 'contactId',
      message: 'Für eine innergemeinschaftliche Leistung braucht der Empfänger eine USt-IdNr.',
    })
  }
  if (!input.serviceFrom && !input.serviceTo) {
    problems.push({
      field: 'serviceFrom',
      message: 'Leistungsdatum oder Leistungszeitraum fehlt.',
    })
  }
  if (input.serviceFrom && input.serviceFrom > input.documentDate) {
    problems.push({
      field: 'serviceFrom',
      message: 'Die Leistung beginnt nach dem Rechnungsdatum. Bitte Datum prüfen.',
    })
  }
  if (input.pricedItemCount === 0) {
    problems.push({ field: 'items', message: 'Die Rechnung enthält noch keine Positionen.' })
  }
  return problems
}

// ---- Pflichthinweise ---------------------------------------------------------------------------

export interface LegalNotesInput {
  kind: InvoiceKind
  taxMode: TaxMode
  /** Recipient is a private person (§ 14 Abs. 4 Satz 1 Nr. 9 UStG: Aufbewahrungshinweis). */
  recipientIsPrivate: boolean
  documentDate: string
  paymentDueDays: number | null
  cashDiscount: { percent: string; days: number; amountCents: bigint } | null
  /** Abschlagsrechnung number (1., 2. …). */
  progressNo: number | null
  /** Cancelled invoice and reason (Stornorechnung). */
  cancels: { number: string; reason: string } | null
}

const TAX_MODE_NOTE: Partial<Record<TaxMode, string>> = {
  reverse_charge_13b:
    'Steuerschuldnerschaft des Leistungsempfängers: Die Umsatzsteuer schuldet der Leistungsempfänger (§ 13b Abs. 2 Nr. 4, Abs. 5 UStG).',
  small_business: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
  intra_eu: 'Steuerfreie innergemeinschaftliche Leistung.',
  export: 'Steuerfreie Ausfuhrlieferung.',
}

/** Texts printed below the totals; stored with the invoice when it is finalized. */
export function invoiceLegalNotes(input: LegalNotesInput): string[] {
  const notes: string[] = []
  if (input.cancels) {
    notes.push(
      `Diese Stornorechnung hebt die Rechnung ${input.cancels.number} vollständig auf. Grund: ${input.cancels.reason}`,
    )
  }
  if (input.kind === 'final') {
    notes.push(
      'Mit dieser Schlussrechnung wird die Leistung abschließend abgerechnet. Die aufgeführten Abschlagsrechnungen sind angerechnet.',
    )
  }
  if (input.kind === 'progress' && input.progressNo) {
    notes.push(`${input.progressNo}. Abschlagsrechnung nach erbrachtem Leistungsstand.`)
  }
  const taxNote = TAX_MODE_NOTE[input.taxMode]
  if (taxNote) notes.push(taxNote)
  if (input.kind !== 'cancellation' && input.paymentDueDays !== null) {
    const due = germanDate(addDays(input.documentDate, input.paymentDueDays))
    if (input.cashDiscount && input.cashDiscount.amountCents > 0n) {
      const until = germanDate(addDays(input.documentDate, input.cashDiscount.days))
      notes.push(
        `Bei Zahlung bis ${until} gewähren wir ${input.cashDiscount.percent.replace('.', ',')} % Skonto (${formatEuro(input.cashDiscount.amountCents)}). Ohne Abzug zahlbar bis ${due}.`,
      )
    } else {
      notes.push(`Zahlbar ohne Abzug bis ${due}.`)
    }
  }
  if (input.recipientIsPrivate && input.kind !== 'cancellation') {
    notes.push(
      'Als Privatperson sind Sie verpflichtet, diese Rechnung, einen Zahlungsbeleg oder eine andere beweiskräftige Unterlage zwei Jahre lang aufzubewahren (§ 14b Abs. 1 Satz 5 UStG).',
    )
  }
  return notes
}

/** Negates a decimal text quantity ("12.5" → "-12.5"), used for Stornorechnungen. */
export function negateQuantity(value: string): string {
  return new Decimal(value).neg().toString()
}
