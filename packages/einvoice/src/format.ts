import { Decimal } from 'decimal.js'

/** Cents as amount with two decimals, e.g. 123456 → "1234.56", -5 → "-0.05". */
export function amount(cents: number | bigint): string {
  const value = BigInt(cents)
  const sign = value < 0n ? '-' : ''
  const abs = value < 0n ? -value : value
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

/** Decimal text without needless trailing zeros (quantities, prices, percents): "12.5000" → "12.5". */
export function decimal(value: Decimal.Value, maxDecimals = 4): string {
  const d = new Decimal(value).toDecimalPlaces(maxDecimals, Decimal.ROUND_HALF_UP)
  return d.isZero() ? '0' : d.toFixed()
}

/** Percent with two decimals as required for VAT rates in the e-invoice: "19" → "19.00". */
export function percent(value: Decimal.Value): string {
  return new Decimal(value).toFixed(2)
}

/** ISO date (YYYY-MM-DD) as UN/CEFACT format 102 (YYYYMMDD) for CII. */
export function cefactDate(isoDate: string): string {
  return isoDate.slice(0, 10).replace(/-/g, '')
}
