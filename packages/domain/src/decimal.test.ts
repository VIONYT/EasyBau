import { describe, expect, it } from 'vitest'
import {
  Decimal,
  formatCents,
  percentToFactor,
  roundQuantity,
  toCents,
  toDecimal,
} from './decimal.js'
import { convertUnit, dimensionOfUnit, isConvertible, UnitConversionError } from './units.js'

describe('decimal helpers', () => {
  it('parses German and international decimal strings, numbers, bigints', () => {
    expect(toDecimal('4,25').toString()).toBe('4.25')
    expect(toDecimal(' -0.5 ').toString()).toBe('-0.5')
    expect(toDecimal(',5').toString()).toBe('0.5')
    expect(toDecimal(12).toString()).toBe('12')
    expect(toDecimal(10n).toString()).toBe('10')
    const d = new Decimal(3)
    expect(toDecimal(d)).toBe(d)
  })

  it('rejects thousands separators, garbage and non-finite numbers', () => {
    expect(() => toDecimal('1.000,50')).toThrow(RangeError)
    expect(() => toDecimal('abc')).toThrow(RangeError)
    expect(() => toDecimal(Number.NaN)).toThrow(RangeError)
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('rounds cents half up, also for negative values (kaufmännisch)', () => {
    expect(toCents(new Decimal('2.5'))).toBe(3n)
    expect(toCents(new Decimal('2.4999'))).toBe(2n)
    expect(toCents(new Decimal('-2.5'))).toBe(-3n)
  })

  it('avoids float errors', () => {
    expect(toDecimal('0.1').plus('0.2').toString()).toBe('0.3')
  })

  it('rounds quantities to four decimals', () => {
    expect(roundQuantity(new Decimal('1.23455'))).toBe('1.2346')
    expect(roundQuantity(new Decimal(2))).toBe('2.0000')
  })

  it('converts percent to factor', () => {
    expect(percentToFactor('19').toString()).toBe('0.19')
    expect(percentToFactor('7,5').toString()).toBe('0.075')
  })

  it('formats cents for display', () => {
    expect(formatCents(123456789n)).toBe('1.234.567,89 €')
    expect(formatCents(-5n)).toBe('-0,05 €')
    expect(formatCents(100n, 'CHF')).toBe('1,00 CHF')
  })
})

describe('unit conversion', () => {
  it.each([
    ['90', 'min', 'Std', '1.5'],
    ['2', 'Wo.', 'Std', '336'],
    ['1', 'pa', 'Wo.', '52'],
    ['1500', 'kg', 't', '1.5'],
    ['2,5', 'km', 'm', '2500'],
    ['12', 'Lfm', 'm', '12'],
    ['500', 'l', 'm³', '0.5'],
  ])('%s %s → %s %s', (value, from, to, expected) => {
    expect(convertUnit(value, from, to).toString()).toBe(expected)
  })

  it('returns the same value for identical units, even unknown ones', () => {
    expect(convertUnit('3', 'Stk.', 'Stk.').toString()).toBe('3')
  })

  it('refuses conversions across dimensions or unknown units', () => {
    expect(() => convertUnit(1, 'm', 'kg')).toThrow(UnitConversionError)
    expect(() => convertUnit(1, 'Sack', 'kg')).toThrow(/Sack/)
    expect(() => convertUnit(1, 'kg', 'Sack')).toThrow(/Sack/)
    expect(isConvertible('min', 'Std')).toBe(true)
    expect(isConvertible('m', 'm²')).toBe(false)
    expect(isConvertible('Eimer', 'l')).toBe(false)
  })

  it('knows the dimension of system units', () => {
    expect(dimensionOfUnit('m²')).toBe('area')
    expect(dimensionOfUnit('Stk.')).toBeUndefined()
  })
})
