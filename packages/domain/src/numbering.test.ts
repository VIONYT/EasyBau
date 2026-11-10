import { describe, expect, it } from 'vitest'
import { checkNumberPattern, formatNumber, patternHasYear } from './numbering.js'

const nov2026 = { year: 2026, month: 11 }

describe('Nummernkreis-Schema', () => {
  it('formats year before or after the running number', () => {
    expect(formatNumber('R{Jahr}-{Nummer}', 101, 5, nov2026)).toBe('R2026-00101')
    expect(formatNumber('R{Nummer}-{Jahr}', 101, 5, nov2026)).toBe('R00101-2026')
    expect(formatNumber('R{FortlaufendeNummer}-{Jahr}', 7, 3, nov2026)).toBe('R007-2026')
    expect(formatNumber('RE-{jj}{monat}/{nummer}', 12n, 4, { year: 2005, month: 3 })).toBe(
      'RE-0503/0012',
    )
    expect(formatNumber('{Nummer}', 123456, 3, nov2026)).toBe('123456')
  })

  it('knows whether the year is part of the number', () => {
    expect(patternHasYear('R{Jahr}-{Nummer}')).toBe(true)
    expect(patternHasYear('R{JJ}{Nummer}')).toBe(true)
    expect(patternHasYear('R-{Monat}-{Nummer}')).toBe(false)
  })

  it('validates schemas with German messages', () => {
    expect(checkNumberPattern('R{Jahr}-{Nummer}')).toBeNull()
    expect(checkNumberPattern('A-{Nummer}')).toBeNull()
    expect(checkNumberPattern(' ')).toMatch(/Schema angeben/)
    expect(checkNumberPattern(`${'X'.repeat(35)}{Nummer}`)).toMatch(/höchstens 40/)
    expect(checkNumberPattern('R{Jahr}')).toMatch(/genau einmal \{Nummer\}/)
    expect(checkNumberPattern('{Nummer}{Nummer}')).toMatch(/genau einmal/)
    expect(checkNumberPattern('R{Tag}{Nummer}')).toMatch(/Unbekannter Platzhalter \{Tag\}/)
    expect(checkNumberPattern('R{{Nummer}')).toMatch(/Klammern/)
    expect(checkNumberPattern('R<{Nummer}>')).toMatch(/Erlaubt sind/)
  })
})
