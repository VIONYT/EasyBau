import { addDays } from './calculation/billing.js'
import { Decimal, toCents, toDecimal } from './decimal.js'

/**
 * Mahnwesen (DESIGN.md §2, §4.6): Zahlungserinnerung → 1. Mahnung → letzte Mahnung, strictly in this
 * order. Verzugszinsen are computed to the day from the statutory base rate (§ 247 BGB) plus 5
 * (consumers) or 9 percentage points (businesses, § 288 Abs. 2 BGB). Fees and interest carry no VAT
 * and never change the invoice; they are claimed only in the dunning letter.
 */
export const DUNNING_LEVELS = ['reminder', 'first', 'final'] as const
export type DunningLevel = (typeof DUNNING_LEVELS)[number]

/** § 288 Abs. 1 / Abs. 2 BGB: percentage points above the base rate. */
export const STATUTORY_INTEREST_POINTS = { consumer: 5, business: 9 } as const

/** § 288 Abs. 5 BGB: Verzugspauschale for businesses, in cents. */
export const LATE_PAYMENT_FLAT_FEE_CENTS = 4000n

/** Basiszinssatz valid from a date (half-yearly, published by the Bundesbank). */
export interface BaseRate {
  validFrom: string
  ratePercent: string
}

export interface InterestSegment {
  /** First and last day with interest (inclusive). */
  from: string
  to: string
  days: number
  /** Annual rate in percent (base rate + points). */
  ratePercent: string
  /** Amount owed in this period. */
  principalCents: bigint
}

/** Payment or deduction during the Verzug: lowers (or, if negative, raises) the principal. */
export interface PrincipalChange {
  /** Day of the payment; the principal changes from the following day. */
  date: string
  amountCents: bigint
}

export interface InterestResult {
  cents: bigint
  segments: InterestSegment[]
}

/** Next level after the issued ones, or null after the final notice. */
export function nextDunningLevel(issued: readonly DunningLevel[]): DunningLevel | null {
  for (const level of DUNNING_LEVELS) if (!issued.includes(level)) return level
  return null
}

export interface DunningDueInput {
  /** Finalized invoice, neither cancelled nor itself a Stornorechnung. */
  eligible: boolean
  openCents: bigint
  /** Fälligkeit of the invoice (or its date when there is none). */
  dueDate: string
  /** Notices issued so far, in order. */
  notices: readonly { level: DunningLevel; dueDate: string }[]
  /** Today in the company's time zone (YYYY-MM-DD). */
  today: string
}

export interface DunningDue {
  /** Next level that can be issued. */
  level: DunningLevel
  /** First day it can be issued: the day after the invoice's or the last notice's deadline. */
  possibleFrom: string
  /** It can be issued today (Mahnvorschlag). */
  due: boolean
}

/** Next Mahnstufe of an invoice and from when it is possible – same rules as issuing a notice. */
export function nextDunningDue(input: DunningDueInput): DunningDue | null {
  if (!input.eligible || input.openCents <= 0n) return null
  const level = nextDunningLevel(input.notices.map((n) => n.level))
  if (!level) return null
  const last = input.notices.at(-1)
  const possibleFrom = addDays(last ? last.dueDate : input.dueDate, 1)
  return { level, possibleFrom, due: possibleFrom <= input.today }
}

function daysInclusive(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 3600 * 1000),
    ) + 1
  )
}

/** Base rate in force on `date`; throws when the table does not reach back that far. */
export function baseRateOn(date: string, rates: readonly BaseRate[]): BaseRate {
  const sorted = [...rates].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1))
  let found: BaseRate | undefined
  for (const rate of sorted) if (rate.validFrom <= date) found = rate
  if (!found) throw new Error(`Kein Basiszinssatz für den ${date} hinterlegt.`)
  return found
}

/**
 * Verzugszinsen from `from` to `to` (both inclusive), to the day (act/365). `principalCents` is owed
 * at the start; payments in between lower it from the day after they were made. The period is split
 * where the base rate or the principal changes; the sum is rounded once to the cent (half up).
 * Periods with a negative rate or no principal yield no interest.
 */
export function defaultInterest(input: {
  principalCents: bigint
  from: string
  to: string
  baseRates: readonly BaseRate[]
  points: number
  payments?: readonly PrincipalChange[]
}): InterestResult {
  if (input.to < input.from) return { cents: 0n, segments: [] }
  const payments = (input.payments ?? []).filter((p) => p.date >= input.from && p.date < input.to)
  const changes = [
    ...input.baseRates.map((r) => r.validFrom),
    ...payments.map((p) => addDays(p.date, 1)),
  ].filter((d) => d > input.from && d <= input.to)
  const starts = [input.from, ...[...new Set(changes)].sort()]
  const segments: InterestSegment[] = []
  for (const [i, start] of starts.entries()) {
    const next = starts[i + 1]
    const end = next ? addDays(next, -1) : input.to
    const paid = payments.filter((p) => p.date < start).reduce((sum, p) => sum + p.amountCents, 0n)
    const principalCents = input.principalCents - paid
    if (principalCents <= 0n) continue
    const rate = toDecimal(baseRateOn(start, input.baseRates).ratePercent).plus(input.points)
    const previous = segments.at(-1)
    const ratePercent = rate.toFixed(2)
    // Merge neighbours with the same rate and principal (e.g. a base rate that did not change).
    if (
      previous &&
      previous.ratePercent === ratePercent &&
      previous.principalCents === principalCents &&
      addDays(previous.to, 1) === start
    ) {
      previous.to = end
      previous.days = daysInclusive(previous.from, end)
      continue
    }
    segments.push({
      from: start,
      to: end,
      days: daysInclusive(start, end),
      ratePercent,
      principalCents,
    })
  }
  const total = segments.reduce((sum, s) => {
    const rate = toDecimal(s.ratePercent)
    if (rate.lte(0)) return sum
    return sum.plus(toDecimal(s.principalCents).times(rate).div(100).times(s.days).div(365))
  }, new Decimal(0))
  return { cents: toCents(total), segments }
}

/** Settings of one level (Einstellungen › Mahnungen). */
export interface DunningLevelRule {
  /** Zahlungsfrist in days from the notice date. */
  days: number
  /** Mahngebühr (no VAT). */
  feeCents: bigint
  /** Charge Verzugszinsen on this level. */
  interest: boolean
}

export interface DunningInput {
  level: DunningLevel
  noticeDate: string
  /** Offene Forderung of the invoice (from receivableState). */
  openCents: bigint
  /** Business customer (no consumer): 9 instead of 5 points, Verzugspauschale possible. */
  business: boolean
  rule: DunningLevelRule
  /** First day of Verzug; null = no interest. */
  interestFrom: string | null
  /**
   * Payments and deductions since the start of the Verzug (already contained in `openCents`): the
   * interest runs on the higher amount until the day they were made.
   */
  paymentsSinceInterestFrom?: readonly PrincipalChange[]
  baseRates: readonly BaseRate[]
  /** Claim the Verzugspauschale (§ 288 Abs. 5 BGB) – only businesses, only once per invoice. */
  flatFee: boolean
  /** Fees and Pauschale of earlier notices, still claimed. */
  earlierChargesCents: bigint
  /** The Pauschale was already claimed in an earlier notice. */
  flatFeeCharged: boolean
}

export interface DunningResult {
  dueDate: string
  feeCents: bigint
  flatFeeCents: bigint
  interestCents: bigint
  /** Rate on the notice date (base rate + points); 0 without interest. */
  interestRatePercent: string
  interestFrom: string | null
  interestTo: string | null
  segments: InterestSegment[]
  earlierChargesCents: bigint
  /** Offene Forderung + all fees + Pauschale + interest. */
  totalCents: bigint
}

/** Amounts and deadline of a dunning notice. */
export function dunningAmounts(input: DunningInput): DunningResult {
  const points = input.business
    ? STATUTORY_INTEREST_POINTS.business
    : STATUTORY_INTEREST_POINTS.consumer
  const withInterest = input.rule.interest && input.interestFrom !== null
  const interest = withInterest
    ? defaultInterest({
        principalCents:
          input.openCents +
          (input.paymentsSinceInterestFrom ?? []).reduce((sum, p) => sum + p.amountCents, 0n),
        from: input.interestFrom as string,
        to: input.noticeDate,
        baseRates: input.baseRates,
        points,
        payments: input.paymentsSinceInterestFrom ?? [],
      })
    : { cents: 0n, segments: [] }
  const flatFeeCents =
    input.business && input.flatFee && !input.flatFeeCharged ? LATE_PAYMENT_FLAT_FEE_CENTS : 0n
  const interestRatePercent = withInterest
    ? toDecimal(baseRateOn(input.noticeDate, input.baseRates).ratePercent).plus(points).toFixed(2)
    : '0.00'
  const hasPeriod = withInterest && interest.segments.length > 0
  return {
    dueDate: addDays(input.noticeDate, input.rule.days),
    feeCents: input.rule.feeCents,
    flatFeeCents,
    interestCents: interest.cents,
    interestRatePercent,
    interestFrom: hasPeriod ? (input.interestFrom as string) : null,
    interestTo: hasPeriod ? input.noticeDate : null,
    segments: interest.segments,
    earlierChargesCents: input.earlierChargesCents,
    totalCents:
      input.openCents +
      input.earlierChargesCents +
      input.rule.feeCents +
      flatFeeCents +
      interest.cents,
  }
}
