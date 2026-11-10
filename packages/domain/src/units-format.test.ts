import { describe, expect, it } from 'vitest'
import { formatUnitQuantity } from './units.js'

describe('Mengen mit Einheit (Handwerksregel)', () => {
  it('shows exactly the decimals of the unit, rounded half up, with thousands separators', () => {
    expect(formatUnitQuantity('186.4', 2)).toBe('186,40')
    expect(formatUnitQuantity('186.40', 2)).toBe('186,40')
    expect(formatUnitQuantity('34.657', 2)).toBe('34,66')
    expect(formatUnitQuantity('1234.5', 3)).toBe('1.234,500')
    expect(formatUnitQuantity('1234567.891', 2)).toBe('1.234.567,89')
    expect(formatUnitQuantity('3', 0)).toBe('3')
    expect(formatUnitQuantity('2.5', 0)).toBe('3')
    expect(formatUnitQuantity('12,5', 2)).toBe('12,50')
  })

  it('keeps the sign of negative quantities (Storno, Abzug) but never shows „-0“', () => {
    expect(formatUnitQuantity('-80', 2)).toBe('-80,00')
    expect(formatUnitQuantity('-1.2345', 3)).toBe('-1,235')
    expect(formatUnitQuantity('-0.001', 2)).toBe('0,00')
  })
})
