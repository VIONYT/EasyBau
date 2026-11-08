import { describe, expect, it } from 'vitest'
import {
  centsToInput,
  formatBytes,
  formatCents,
  formatInputNumber,
  formatQuantity,
  parseEuro,
} from './format'

describe('money input and output', () => {
  it('parses German and English amounts exactly into cents', () => {
    expect(parseEuro('1.234,56')).toBe(123_456)
    expect(parseEuro('12,5')).toBe(1250)
    expect(parseEuro('12.50')).toBe(1250)
    expect(parseEuro('1.234')).toBe(123_400)
    expect(parseEuro('1234 €')).toBe(123_400)
    expect(parseEuro('0,1')).toBe(10)
    expect(parseEuro('-5,99')).toBe(-599)
    expect(parseEuro('')).toBeNull()
    expect(parseEuro('1,234')).toBeNaN()
    expect(parseEuro('abc')).toBeNaN()
  })

  it('formats cents for display and input', () => {
    expect(formatCents(123_456)).toBe('1.234,56 €')
    expect(formatCents(null)).toBe('')
    expect(centsToInput(123_456)).toBe('1234,56')
    expect(centsToInput(-5)).toBe('-0,05')
    expect(centsToInput(null)).toBe('')
    expect(formatQuantity('12.5')).toBe('12,5')
    expect(formatQuantity('38.2200')).toBe('38,22')
    expect(formatQuantity('40.0000')).toBe('40')
    expect(formatQuantity('100')).toBe('100')
    expect(formatQuantity('34.657')).toBe('34,66')
    expect(formatQuantity('-1.7789')).toBe('-1,78')
    expect(formatQuantity('2.345')).toBe('2,35')
    expect(formatQuantity('kein')).toBe('kein')
    expect(formatQuantity('1.2345', 3)).toBe('1,235')
    expect(formatQuantity('2.5', 0)).toBe('3')
    expect(formatInputNumber('0.885')).toBe('0,885')
    expect(formatInputNumber('4.2500')).toBe('4,25')
    expect(formatInputNumber(null)).toBe('')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })
})
