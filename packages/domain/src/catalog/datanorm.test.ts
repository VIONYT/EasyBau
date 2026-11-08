import { describe, expect, it } from 'vitest'
import {
  DatanormError,
  decodeBytes,
  detectEncoding,
  joinLongText,
  LineSplitter,
  mapDatanormUnit,
  parseDatanormLine,
  parseDatanormPrice,
  unitCostCents,
} from './datanorm.js'

const parse = (text: string) => parseDatanormLine(text, 7)

describe('DATANORM records', () => {
  it('reads the header (Vorlaufsatz)', () => {
    expect(parse('V;050;01112026;Baustoff Nord GmbH;Katalog 2027;;EUR')).toEqual({
      type: 'header',
      header: {
        version: '050',
        date: '01112026',
        supplier: 'Baustoff Nord GmbH',
        info: ['Baustoff Nord GmbH', 'Katalog 2027'],
        currency: 'EUR',
      },
    })
    expect(parse('V;040')).toMatchObject({
      header: { version: '040', supplier: null, currency: 'EUR' },
    })
    expect(parse('V;040;;;;;')).toMatchObject({
      header: { supplier: null, date: null, currency: 'EUR', info: [] },
    })
  })

  it('reads articles with list price, price unit and unit', () => {
    expect(parse('A;N;4711;00;Dispersionsfarbe weiß;12,5 l;1;0;Eim;4599;R10;MAL;T4711\r')).toEqual({
      type: 'article',
      article: {
        action: 'new',
        articleNo: '4711',
        shortText: 'Dispersionsfarbe weiß 12,5 l',
        priceKind: 'list',
        priceUnit: 1,
        unitRaw: 'Eim',
        unitSymbol: 'Eimer',
        priceCents: '4599',
        discountGroup: 'R10',
        productGroup: 'MAL',
        longTextKey: 'T4711',
      },
    })
    const net = parse('A;A;0815;00;Schraube;;2;2;Stck;12,34;;;')
    expect(net).toMatchObject({
      article: {
        action: 'change',
        priceKind: 'net',
        priceUnit: 100,
        unitSymbol: 'Stk.',
        priceCents: '1234',
        longTextKey: null,
      },
    })
    expect(parse('A;L;X1;;;;;3;Fass;;;;')).toMatchObject({
      article: {
        action: 'delete',
        shortText: 'X1',
        priceUnit: 1000,
        unitSymbol: null,
        priceCents: '0',
        discountGroup: null,
      },
    })
    expect(parse('A;N;X3;;Kurz;;1;0;m')).toMatchObject({
      article: { priceCents: '0', discountGroup: null },
    })
    expect(parse('A;;X2;;;;;1;m;12.5;;;')).toMatchObject({
      article: { action: 'new', priceUnit: 10, priceCents: '1250' },
    })
  })

  it('reads EAN, long texts and price changes', () => {
    expect(parse('B;N;4711;FARBE WEISS;;;;;4012345678901;;')).toEqual({
      type: 'extra',
      extra: { action: 'new', articleNo: '4711', matchcode: 'FARBE WEISS', ean: '4012345678901' },
    })
    expect(parse('B;N;4712;;')).toMatchObject({ extra: { matchcode: null, ean: null } })
    expect(parse('T;N;T4711;1;0;Hochdeckende Innenfarbe,  ;2;0;scheuerbeständig Klasse 2')).toEqual(
      {
        type: 'text',
        texts: [
          { key: 'T4711', line: 1, text: 'Hochdeckende Innenfarbe,' },
          { key: 'T4711', line: 2, text: 'scheuerbeständig Klasse 2' },
        ],
      },
    )
    expect(parse('T;N;T1;x;0;ignoriert;3;0')).toEqual({
      type: 'text',
      texts: [{ key: 'T1', line: 3, text: '' }],
    })
    expect(parse('P;A;4711;1;4899;;;;;;;0815;2;1199;;;;;;;;;;;;;;;')).toEqual({
      type: 'price',
      prices: [
        { articleNo: '4711', priceKind: 'list', priceCents: '4899' },
        { articleNo: '0815', priceKind: 'net', priceCents: '1199' },
      ],
    })
  })

  it('tolerates truncated price records', () => {
    expect(parse('P;A;4711;1')).toEqual({
      type: 'price',
      prices: [{ articleNo: '4711', priceKind: 'list', priceCents: '0' }],
    })
  })

  it('skips unknown and empty records', () => {
    expect(parse('R;N;R10;30')).toEqual({ type: 'skip', recordType: 'R' })
    expect(parse('   ')).toBeNull()
  })

  it('reports broken lines with their number', () => {
    expect(() => parse('A0000815Schraube')).toThrow(/Zeile 7: Keine DATANORM-4\/5-Datei/)
    expect(() => parse('A;N;;')).toThrow(/Artikelnummer fehlt/)
    expect(() => parse('B;N;;')).toThrow(/Artikelnummer fehlt/)
    expect(() => parse('T;N;;1;0;x')).toThrow(/Textschlüssel fehlt/)
    expect(() => parse('A;X;1;;a;;1;0;m;1;;;')).toThrow(/Verarbeitungskennzeichen/)
    expect(() => parse('A;N;1;;a;;1;9;m;1;;;')).toThrow(/Preiseinheit/)
    expect(() => parse('A;N;1;;a;;1;0;m;1,2,3;;;')).toThrow(DatanormError)
    expect(new DatanormError('x').message).toBe('x')
  })
})

describe('DATANORM helpers', () => {
  it('parses prices in cents or euros', () => {
    expect(parseDatanormPrice('00012345')).toBe('12345')
    expect(parseDatanormPrice('123,456')).toBe('12345.6')
    expect(parseDatanormPrice('')).toBe('0')
    expect(() => parseDatanormPrice('abc')).toThrow(/Ungültiger Preis/)
  })

  it('maps wholesaler units to system units', () => {
    expect(
      ['STCK', 'm2', 'QM', 'm3', 'Ltr', 'Rol', 'Pak', 'Sack', 'kg', 't', 'lfm'].map(
        mapDatanormUnit,
      ),
    ).toEqual(['Stk.', 'm²', 'm²', 'm³', 'l', 'Rolle', 'Pkg', 'Sack', 'kg', 't', 'Lfm'])
    expect(mapDatanormUnit('Fass')).toBeNull()
  })

  it('computes the cost of one unit from price unit and discount', () => {
    const list = { priceCents: '1234', priceUnit: 100, priceKind: 'list' as const }
    expect(unitCostCents(list, '30').toString()).toBe('8.638')
    expect(unitCostCents(list).toString()).toBe('12.34')
    expect(unitCostCents({ ...list, priceKind: 'net' }, 30).toString()).toBe('12.34')
  })

  it('joins long text lines in order', () => {
    expect(
      joinLongText([
        { line: 2, text: 'b' },
        { line: 1, text: 'a ' },
      ]),
    ).toBe('a \nb')
  })

  it('splits streamed text into numbered lines', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('A;1\nA;')).toEqual([{ text: 'A;1', line: 1 }])
    expect(splitter.push('2\r\nA;3')).toEqual([{ text: 'A;2\r', line: 2 }])
    expect(splitter.end()).toEqual([{ text: 'A;3', line: 3 }])
    expect(splitter.end()).toEqual([])
  })
})

describe('character set', () => {
  const ascii = new TextEncoder().encode('A;N;1;;Schraube')
  const utf8 = new TextEncoder().encode('A;N;1;;Fliesenkleber für Außen')
  const cp850 = Uint8Array.from([0x46, 0x81, 0x72, 0x20, 0x41, 0x75, 0xe1, 0x65, 0x6e, 0x20, 0x84]) // Für Außen ä
  const latin1 = Uint8Array.from([0x46, 0xfc, 0x72, 0x20, 0x41, 0x75, 0xdf, 0x65, 0x6e]) // Für Außen

  it('detects UTF-8, CP850 and Latin-1', () => {
    expect(detectEncoding(ascii)).toBe('utf-8')
    expect(detectEncoding(utf8)).toBe('utf-8')
    // A sample cut in the middle of a multi-byte character is still UTF-8.
    const umlautAtEnd = new TextEncoder().encode('Größe ä')
    expect(detectEncoding(umlautAtEnd.subarray(0, umlautAtEnd.length - 1))).toBe('utf-8')
    expect(detectEncoding(cp850)).toBe('cp850')
    expect(detectEncoding(latin1)).toBe('latin1')
  })

  it('decodes CP850 and Latin-1', () => {
    expect(decodeBytes(cp850, 'cp850')).toBe('Für Außen ä')
    expect(decodeBytes(latin1, 'latin1')).toBe('Für Außen')
  })
})
