import { Decimal as DecimalLib } from 'decimal.js'

/**
 * Isolated Decimal constructor for all business arithmetic (CLAUDE.md rule 1: never floats).
 * 40 significant digits are far more than any construction quantity or amount needs.
 * ROUND_HALF_UP = kaufmännische Rundung (ties away from zero, also for negative values).
 */
export const Decimal = DecimalLib.clone({ precision: 40, rounding: DecimalLib.ROUND_HALF_UP })
export type Decimal = InstanceType<typeof Decimal>

/** Accepted numeric input: decimal string ("12.5" or "12,5"), safe integer/number, bigint or Decimal. */
export type NumericInput = string | number | bigint | Decimal

/** Quantities are stored as numeric(18,4) → four decimal places. */
export const QUANTITY_DECIMALS = 4

const GERMAN_NUMBER = /^[+-]?(\d+([.,]\d+)?|[.,]\d+)$/

/**
 * Converts input to Decimal. Strings may use a decimal comma ("4,25").
 * Thousands separators are rejected on purpose to avoid ambiguity ("1.000" ≠ 1).
 */
export function toDecimal(value: NumericInput): Decimal {
  if (value instanceof Decimal) return value
  if (typeof value === 'bigint') return new Decimal(value.toString())
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`)
    return new Decimal(value)
  }
  const trimmed = value.trim()
  if (!GERMAN_NUMBER.test(trimmed)) throw new RangeError(`Not a number: "${value}"`)
  return new Decimal(trimmed.replace(',', '.'))
}

/** Rounds to whole cents (half up) and returns a bigint, the storage format for money. */
export function toCents(value: Decimal): bigint {
  return BigInt(value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0))
}

/** Rounds a quantity to 4 decimals and returns it as a plain decimal string ("12.5000"). */
export function roundQuantity(value: Decimal): string {
  return value.toDecimalPlaces(QUANTITY_DECIMALS, Decimal.ROUND_HALF_UP).toFixed(QUANTITY_DECIMALS)
}

/** Percent (e.g. 19 or "7,5") as factor: 19 → 0.19. */
export function percentToFactor(percent: NumericInput): Decimal {
  return toDecimal(percent).div(100)
}

/** Formats cents for German display, e.g. 123456n → "1.234,56 €". UI helper, not used for storage. */
export function formatCents(cents: bigint, currency = 'EUR'): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const euros = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const rest = (abs % 100n).toString().padStart(2, '0')
  const symbol = currency === 'EUR' ? '€' : currency
  return `${negative ? '-' : ''}${euros},${rest} ${symbol}`
}
