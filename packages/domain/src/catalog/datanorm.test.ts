import { describe, expect, it } from 'vitest'
import {
  DatanormError,
  decodeBytes,
  detectEncoding,
  joinLongText,
  LineSplitter,
  MAX_DATANORM_LINE,
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

  it('reads the fixed-width header of DATANORM 4', () => {
    const fixed = (date: string, info: string[], version: string, currency: string) =>
      `V ${date.padEnd(6)}${(info[0] ?? '').padEnd(40)}${(info[1] ?? '').padEnd(40)}${(info[2] ?? '').padEnd(35)}${version.padEnd(2)}${currency}`
    // Layout as in a real wholesaler file (Belimo, 128 characters).
    const line = fixed('191026', ['Belimo', 'ab 01.01.2027'], '04', 'EUR')
    expect(line).toHaveLength(128)
    expect(parse(`${line}\r`)).toEqual({
      type: 'header',
      header: {
        version: '04',
        date: '191026',
        supplier: 'Belimo',
        info: ['Belimo', 'ab 01.01.2027'],
        currency: 'EUR',
      },
    })
    expect(parse(fixed('', [], '', ''))).toMatchObject({
      header: { version: '04', date: null, supplier: null, info: [], currency: 'EUR' },
    })
    expect(() => parse(fixed('010195', ['Alt'], '03', 'DM '))).toThrow(
      /Zeile 7: DATANORM-Version 03 wird nicht unterstützt/,
    )
  })

  it('reads discount groups (Rabattsatz, file *.RAB)', () => {
    expect(parse('R;;80;1;0;Gueltig fuer S8;')).toEqual({
      type: 'discount',
      discount: {
        action: 'new',
        discountGroup: '80',
        kind: 'percent',
        percent: '0',
        text: 'Gueltig fuer S8',
      },
    })
    expect(parse('R;A;W5;1;3550;')).toMatchObject({
      discount: { action: 'change', discountGroup: 'W5', percent: '35.5', text: null },
    })
    expect(parse('R;N;W6;1;12,5')).toMatchObject({ discount: { percent: '12.5' } })
    expect(parse('R;N;W7;1')).toMatchObject({ discount: { percent: null } })
    expect(parse('R;N;M1;2;1250;Multi')).toMatchObject({
      discount: { kind: 'other', percent: null },
    })
    expect(() => parse('R;N;;1;10')).toThrow(/Rabattgruppe fehlt/)
    expect(() => parse('R;N;X;1;10000')).toThrow(/100 % oder mehr/)
    expect(() => parse('R;N;X;1;abc')).toThrow(/Ungültiger Rabatt/)
  })

  it('skips product groups (Warengruppe, file *.WRG)', () => {
    expect(parse('S;;S2;;AntriebeFU;Antriebe für raue Umgebungsbedingungen;')).toEqual({
      type: 'skip',
      recordType: 'S',
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
    // Real DATANORM 4 file (Belimo): an empty field after the key, empty Kennzeichen.
    expect(parse('T;N;T9220;;1;;Differenzdruckschalter;2;;Messbereich 200...1000 Pa;')).toEqual({
      type: 'text',
      texts: [
        { key: 'T9220', line: 1, text: 'Differenzdruckschalter' },
        { key: 'T9220', line: 2, text: 'Messbereich 200...1000 Pa' },
      ],
    })
    expect(parse('T;N;T9220;;11;;Typ 01APS-101;;;;')).toEqual({
      type: 'text',
      texts: [{ key: 'T9220', line: 11, text: 'Typ 01APS-101' }],
    })
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
    expect(parse('Z;N;R10;30')).toEqual({ type: 'skip', recordType: 'Z' })
    expect(parse('   ')).toBeNull()
    expect(parse('\u001a')).toBeNull()
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

  it('refuses lines longer than any DATANORM record (no quadratic growth)', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('A;1\n')).toEqual([{ text: 'A;1', line: 1 }])
    const chunk = 'T;'.padEnd(16 * 1024, 'x')
    expect(() => {
      for (let i = 0; i < 10; i++) splitter.push(chunk)
    }).toThrow(/Zeile 2: Die Zeile ist zu lang/)
    const long = new LineSplitter()
    expect(() => long.push(`${'x'.repeat(MAX_DATANORM_LINE + 1)}\nA;1`)).toThrow(DatanormError)
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
