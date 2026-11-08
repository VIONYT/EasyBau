import { Decimal, type NumericInput, toDecimal } from './decimal.js'

/** Dimensions of the unit table (DESIGN.md §4.2.1). */
export type Dimension =
  | 'length'
  | 'area'
  | 'volume'
  | 'mass'
  | 'time'
  | 'count'
  | 'container'
  | 'lump_sum'
  | 'power'

/**
 * Conversion factors to the base unit of each dimension, keyed by the system unit symbol.
 * Only conversions within one dimension are allowed. 1 pa = 52 Wo. (calculation aid only).
 */
const FACTORS: Record<string, { dimension: Dimension; factor: Decimal }> = {
  m: { dimension: 'length', factor: new Decimal(1) },
  Lfm: { dimension: 'length', factor: new Decimal(1) },
  km: { dimension: 'length', factor: new Decimal(1000) },
  'm²': { dimension: 'area', factor: new Decimal(1) },
  'm³': { dimension: 'volume', factor: new Decimal(1) },
  l: { dimension: 'volume', factor: new Decimal('0.001') },
  kg: { dimension: 'mass', factor: new Decimal(1) },
  t: { dimension: 'mass', factor: new Decimal(1000) },
  min: { dimension: 'time', factor: new Decimal(1) },
  Std: { dimension: 'time', factor: new Decimal(60) },
  'Wo.': { dimension: 'time', factor: new Decimal(60 * 24 * 7) },
  pa: { dimension: 'time', factor: new Decimal(60 * 24 * 7 * 52) },
}

export class UnitConversionError extends Error {
  override name = 'UnitConversionError'
}

export function isConvertible(from: string, to: string): boolean {
  const a = FACTORS[from]
  const b = FACTORS[to]
  return !!a && !!b && a.dimension === b.dimension
}

/** Converts a value between two units of the same dimension, e.g. 90 min → 1.5 Std. */
export function convertUnit(value: NumericInput, from: string, to: string): Decimal {
  if (from === to) return toDecimal(value)
  const a = FACTORS[from]
  const b = FACTORS[to]
  if (!a || !b) throw new UnitConversionError(`Keine Umrechnung für ${!a ? from : to} bekannt.`)
  if (a.dimension !== b.dimension) {
    throw new UnitConversionError(`${from} und ${to} sind nicht ineinander umrechenbar.`)
  }
  return toDecimal(value).mul(a.factor).div(b.factor)
}

/** Dimension a measurement formula template produces; used for the unit-mismatch hint. */
export function dimensionOfUnit(symbol: string): Dimension | undefined {
  return FACTORS[symbol]?.dimension
}
