import { addDays } from './calculation/billing.js'
import { type NumericInput, percentToFactor, toCents, toDecimal } from './decimal.js'

/**
 * Offene Forderungen (DESIGN.md §4.6) – deliberately no bookkeeping: per invoice there are payments
 * and deductions (Abzüge/Kürzungen); the open amount and the status follow from them. Nothing here
 * posts to accounts.
 */
export type ReceivableStatus =
  | 'open'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'dunned'
  | 'cancelled'

export const ADJUSTMENT_KINDS = [
  'cash_discount',
  'retention',
  'construction_levy',
  'bank_fee',
  'short_payment',
  'other',
] as const
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number]

export interface ReceivableAdjustment {
  kind: AdjustmentKind
  amountCents: bigint
}

export interface ReceivableInput {
  /** Rechnungsbetrag brutto. */
  grossCents: bigint
  /** Sum of payments, reversals included (negative). */
  paidCents: bigint
  adjustments: readonly ReceivableAdjustment[]
  /** Fälligkeit (document date + payment term); null = due immediately. */
  dueDate: string | null
  /** Today in the company's time zone (YYYY-MM-DD). */
  today: string
  /** The invoice is cancelled or is itself a Stornorechnung. */
  cancelled: boolean
  /** A dunning notice (Mahnung) has been sent. */
  dunned: boolean
}

export interface ReceivableState {
  status: ReceivableStatus
  /** Offene Forderung, never negative. */
  openCents: bigint
  /** Overpayment (Guthaben des Kunden), never negative. */
  creditCents: bigint
  /** Sum of all deductions (Skonto, Einbehalt, Kürzung …). */
  adjustedCents: bigint
  /** Sicherheitseinbehalt currently withheld by the customer (paid out later). */
  retentionHeldCents: bigint
  /** Days past the due date (only when overdue or dunned). */
  overdueDays: number
}

const sumOf = (adjustments: readonly ReceivableAdjustment[], kind?: AdjustmentKind) =>
  adjustments
    .filter((a) => kind === undefined || a.kind === kind)
    .reduce((sum, a) => sum + a.amountCents, 0n)

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 3600 * 1000),
  )
}

/** Open amount and status of an invoice: gross − payments − deductions. */
export function receivableState(input: ReceivableInput): ReceivableState {
  const adjustedCents = sumOf(input.adjustments)
  const retentionHeldCents = sumOf(input.adjustments, 'retention')
  const remaining = input.grossCents - input.paidCents - adjustedCents
  if (input.cancelled) {
    return {
      status: 'cancelled',
      openCents: 0n,
      creditCents: 0n,
      adjustedCents,
      retentionHeldCents,
      overdueDays: 0,
    }
  }
  const openCents = remaining > 0n ? remaining : 0n
  const creditCents = remaining < 0n ? -remaining : 0n
  const overdueDays =
    openCents > 0n && input.dueDate && input.today > input.dueDate
      ? daysBetween(input.dueDate, input.today)
      : 0
  let status: ReceivableStatus
  if (openCents === 0n) status = 'paid'
  else if (input.dunned) status = 'dunned'
  else if (overdueDays > 0) status = 'overdue'
  else if (input.paidCents !== 0n || adjustedCents !== 0n) status = 'partially_paid'
  else status = 'open'
  return { status, openCents, creditCents, adjustedCents, retentionHeldCents, overdueDays }
}

export interface SettlementInput {
  /** Open amount before this payment. */
  openCents: bigint
  amountCents: bigint
  paidOn: string
  documentDate: string
  cashDiscountPercent: NumericInput | null
  cashDiscountDays: number | null
  /** Zahlbetrag of the invoice (gross − Einbehalt − Bauumlage), the Skonto base. */
  payableCents: bigint
  /** Einbehalt and Bauumlage as stated on the invoice. */
  retentionCents: bigint
  constructionLevyCents: bigint
  /** Deductions already recorded for the invoice. */
  adjustments: readonly ReceivableAdjustment[]
}

/**
 * When a payment leaves exactly the Sicherheitseinbehalt, the Bauumlage and/or an allowed Skonto
 * open, these are suggested as deductions so the invoice is settled. Any other difference is a
 * partial payment: no suggestion.
 */
export function settlementSuggestion(input: SettlementInput): ReceivableAdjustment[] {
  let rest = input.openCents - input.amountCents
  if (rest <= 0n) return []
  const suggestions: ReceivableAdjustment[] = []
  const take = (kind: AdjustmentKind, planned: bigint) => {
    const left = planned - sumOf(input.adjustments, kind)
    if (left > 0n && rest >= left) {
      suggestions.push({ kind, amountCents: left })
      rest -= left
    }
  }
  take('retention', input.retentionCents)
  take('construction_levy', input.constructionLevyCents)
  if (rest > 0n && input.cashDiscountPercent !== null && input.cashDiscountDays !== null) {
    const lastDay = addDays(input.documentDate, input.cashDiscountDays)
    const allowed =
      toCents(toDecimal(input.payableCents).mul(percentToFactor(input.cashDiscountPercent))) -
      sumOf(input.adjustments, 'cash_discount')
    if (input.paidOn <= lastDay && rest <= allowed) {
      suggestions.push({ kind: 'cash_discount', amountCents: rest })
      rest = 0n
    }
  }
  return rest === 0n ? suggestions : []
}
