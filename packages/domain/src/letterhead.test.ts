import { describe, expect, it } from 'vitest'
import {
  clampToPage,
  DIN5008B,
  defaultLetterhead,
  fillPlaceholders,
  formatIban,
  LETTERHEAD_FIELDS,
  PAPER_FORMATS,
} from './letterhead.js'

describe('Briefpapier DIN 5008 B', () => {
  it('uses the zones of Form B', () => {
    expect(DIN5008B.header.height).toBe(45)
    expect(DIN5008B.address).toMatchObject({ x: 20, y: 45, width: 85, height: 45 })
    expect(DIN5008B.marks).toEqual({ fold1: 105, fold2: 210, hole: 148.5 })
  })

  it('fills placeholders and drops lines without any value', () => {
    const values = {
      Firma: 'Muster Bau GmbH',
      Straße: 'Werkstraße 2',
      PLZ: '30169',
      Ort: 'Hannover',
      Telefon: '',
    }
    expect(fillPlaceholders('{Firma} · {Straße} · {PLZ} {Ort}', values)).toBe(
      'Muster Bau GmbH · Werkstraße 2 · 30169 Hannover',
    )
    expect(fillPlaceholders('{firma}\nTel. {Telefon}\n{ort}', values)).toBe(
      'Muster Bau GmbH\nHannover',
    )
    // Empty parts between separators are removed; unknown placeholders stay.
    expect(fillPlaceholders('{E-Mail} · {Ort} · {Web}', { Ort: 'Hannover', 'E-Mail': null })).toBe(
      'Hannover',
    )
    expect(fillPlaceholders('{Firma}   ', values)).toBe('Muster Bau GmbH')
    expect(fillPlaceholders('Seite {Seite}', values)).toBe('Seite {Seite}')
    expect(fillPlaceholders('Freier Text', {})).toBe('Freier Text')
  })

  it('formats the IBAN in groups of four', () => {
    expect(formatIban('DE89370400440532013000')).toBe('DE89 3704 0044 0532 0130 00')
    expect(formatIban('DE89 3704 0044')).toBe('DE89 3704 0044')
  })

  it('offers a complete default letterhead using only known placeholders', () => {
    const layout = defaultLetterhead()
    const known = new Set(LETTERHEAD_FIELDS.map(([key]) => key))
    const texts = [layout.senderLine, ...layout.footer, ...layout.texts.map((t) => t.text)].join(
      ' ',
    )
    for (const [, name] of texts.matchAll(/\{([^{}]+)\}/g)) {
      expect(known.has(name as never)).toBe(true)
    }
    expect(layout.footer).toHaveLength(4)
    expect(layout.paper).toBe('A4')
    expect(PAPER_FORMATS[layout.paper]).toEqual(DIN5008B.page)
  })

  it('keeps elements on the page', () => {
    expect(clampToPage(-5, 50, 40)).toEqual({ x: 0, y: 45 })
    expect(clampToPage(190.04, -1, 40)).toEqual({ x: 170, y: 0 })
    expect(clampToPage(12.345, 20.06, 40, 250)).toEqual({ x: 12.3, y: 20.1 })
  })
})
