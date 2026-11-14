import { describe, expect, it } from 'vitest'
import { checkFileNamePattern, DEFAULT_FILE_NAME_PATTERN, fileNameFrom } from './file-names.js'

describe('Dateinamen-Muster', () => {
  it('fills the placeholders and keeps umlauts', () => {
    expect(
      fileNameFrom(
        '{Typ}_{Nummer}_{Kunde}',
        { Typ: 'Rechnung', Nummer: 'R2026-00101', Kunde: 'Müller, Jörg' },
        'pdf',
      ),
    ).toBe('Rechnung_R2026-00101_Müller,_Jörg.pdf')
    expect(fileNameFrom(DEFAULT_FILE_NAME_PATTERN, { Typ: 'Angebot', Nummer: 'A-1' }, 'pdf')).toBe(
      'Angebot_A-1.pdf',
    )
    expect(
      fileNameFrom(
        '{Jahr}-{Projekt} {Datum}',
        { Jahr: '2026', Projekt: 'Bad', Datum: '2026-11-13' },
        'pdf',
      ),
    ).toBe('2026-Bad_2026-11-13.pdf')
  })

  it('removes forbidden characters and doubled separators of missing values', () => {
    expect(fileNameFrom('{Typ}_{Nummer}_{Kunde}', { Typ: 'Angebot', Nummer: null }, 'pdf')).toBe(
      'Angebot.pdf',
    )
    expect(
      fileNameFrom('{Typ}_{Nummer}', { Typ: 'Rechnung', Nummer: 'A/B:C*?"<>|\\1\u0001' }, 'pdf'),
    ).toBe('Rechnung_ABC1.pdf')
    expect(fileNameFrom('{Kunde}', { Kunde: '...' }, 'pdf')).toBe('Dokument.pdf')
    expect(fileNameFrom('{Kunde}', {}, 'xml')).toBe('Dokument.xml')
    expect(fileNameFrom('{Typ}', { Typ: 'x'.repeat(150) }, 'pdf')).toBe(`${'x'.repeat(120)}.pdf`)
    expect(fileNameFrom('{Typ}', { Typ: `${'x'.repeat(119)} y` }, 'pdf')).toBe(
      `${'x'.repeat(119)}.pdf`,
    )
  })

  it('checks the pattern', () => {
    expect(checkFileNamePattern(DEFAULT_FILE_NAME_PATTERN)).toBeNull()
    expect(checkFileNamePattern('  ')).toBe('Das Muster ist leer.')
    expect(checkFileNamePattern(`{Nummer}${'x'.repeat(200)}`)).toMatch(/zu lang/)
    expect(checkFileNamePattern('{Typ}_{Rechnung}')).toBe('Unbekannter Platzhalter: {Rechnung}.')
    expect(checkFileNamePattern('{Kunde}')).toMatch(/braucht \{Nummer\} oder \{Typ\}/)
  })
})
