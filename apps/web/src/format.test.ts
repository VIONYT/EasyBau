import { describe, expect, it } from 'vitest'
import { centsToInput, formatBytes, formatCents, formatQuantity, parseEuro } from './format'

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
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })
})
