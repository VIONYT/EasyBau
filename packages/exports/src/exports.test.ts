import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  csv,
  customerAccount,
  datevBookingBatch,
  datevBookings,
  encodeWindows1252,
  fiscalYearStart,
  germanAmount,
  germanDate,
  gobdIndexXml,
  gobdTableCsv,
  incomingBookings,
  inputTaxKey,
  revenueAccount,
  safeEntryName,
  splitByWeights,
  zipStream,
} from './index.js'

/** Reads a ZIP via its central directory (as unzip tools do) and returns name → content. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = zip.readUInt16LE(end + 10)
  let pos = zip.readUInt32LE(end + 16)
  const files = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50)
    const crc = zip.readUInt32LE(pos + 16)
    const size = zip.readUInt32LE(pos + 20)
    const nameLength = zip.readUInt16LE(pos + 28)
    const offset = zip.readUInt32LE(pos + 42)
    const name = zip.subarray(pos + 46, pos + 46 + nameLength).toString('utf8')
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50)
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26)
    const data = zip.subarray(dataStart, dataStart + size)
    expect(crc32(data) >>> 0).toBe(crc)
    files.set(name, data)
    pos += 46 + nameLength
  }
  return files
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of stream) parts.push(part)
  return Buffer.concat(parts)
}

describe('zip', () => {
  it('writes readable archives with streamed and text entries', async () => {
    async function* chunks() {
      yield Buffer.from('Hallo ')
      yield new Uint8Array([0x57, 0x65, 0x6c, 0x74])
    }
    const zip = await collect(
      zipStream([
        { name: 'index.xml', data: '<DataSet/>', modified: new Date(2026, 10, 9, 10, 30, 12) },
        { name: 'Ablage/Fotos/Fassade Süd.jpg', data: chunks() },
        { name: 'leer.txt', data: Buffer.alloc(0), modified: new Date(1970, 0, 1) },
      ]),
    )
    const files = readZip(zip)
    expect([...files.keys()]).toEqual(['index.xml', 'Ablage/Fotos/Fassade Süd.jpg', 'leer.txt'])
    expect(files.get('Ablage/Fotos/Fassade Süd.jpg')?.toString()).toBe('Hallo Welt')
    expect(files.get('leer.txt')?.length).toBe(0)
  })

  it('accepts async entry sources and empty archives', async () => {
    async function* entries() {
      yield { name: 'a.txt', data: 'a' }
    }
    expect([...readZip(await collect(zipStream(entries()))).keys()]).toEqual(['a.txt'])
    expect(readZip(await collect(zipStream([]))).size).toBe(0)
  })

  it('keeps entry names inside the archive', () => {
    expect(safeEntryName('../../etc/passwd')).toBe('etc/passwd')
    expect(safeEntryName('\\\\server\\a\\.\\b.txt')).toBe('server/a/b.txt')
    expect(() => safeEntryName('../..')).toThrow(/empty/)
  })
})

describe('csv', () => {
  it('quotes when needed and formats German amounts and dates', () => {
    expect(
      csv(
        ['A', 'B'],
        [
          ['x;y', 'Er sagte "Hallo"'],
          [1, null],
          [undefined, 'z'],
        ],
      ),
    ).toBe('A;B\r\n"x;y";"Er sagte ""Hallo"""\r\n1;\r\n;z\r\n')
    expect([germanAmount(123456n), germanAmount(-5), germanAmount('100')]).toEqual([
      '1234,56',
      '-0,05',
      '1,00',
    ])
    expect(germanDate('2026-11-09')).toBe('09.11.2026')
  })

  it('encodes Windows-1252 for DATEV', () => {
    expect([...encodeWindows1252('Größe 5 € „x“ – ok 😀')]).toEqual([
      0x47, 0x72, 0xf6, 0xdf, 0x65, 0x20, 0x35, 0x20, 0x80, 0x20, 0x84, 0x78, 0x93, 0x20, 0x96,
      0x20, 0x6f, 0x6b, 0x20, 0x3f,
    ])
  })
})

describe('DATEV', () => {
  const accounts = {
    standard19: '8400',
    reduced7: '8300',
    reverseCharge: '8337',
    exempt: '8120',
    bank: '1200',
  }

  it('maps tax lines to revenue accounts', () => {
    expect(revenueAccount({ category: 'S', ratePercent: '19.00' }, accounts)).toBe('8400')
    expect(revenueAccount({ category: 'S', ratePercent: '7.00' }, accounts)).toBe('8300')
    expect(revenueAccount({ category: 'AE', ratePercent: '0.00' }, accounts)).toBe('8337')
    expect(revenueAccount({ category: 'E', ratePercent: '0.00' }, accounts)).toBe('8120')
  })

  it('books invoices per tax rate and payments, cancellations on Haben', () => {
    const bookings = datevBookings(
      [
        {
          number: 'R-00101',
          date: '2026-11-09',
          customerAccount: '10001',
          customerName: 'Wohnbau Nord eG',
          taxLines: [
            { category: 'S', ratePercent: '19.00', netCents: 100_000n, taxCents: 19_000n },
            { category: 'S', ratePercent: '7.00', netCents: 1_000n, taxCents: 70n },
            { category: 'S', ratePercent: '19.00', netCents: 0n, taxCents: 0n },
          ],
        },
        {
          number: 'R-00102',
          date: '2026-11-10',
          customerAccount: '10001',
          customerName: 'Wohnbau Nord eG',
          taxLines: [
            { category: 'S', ratePercent: '19.00', netCents: -100_000n, taxCents: -19_000n },
          ],
        },
      ],
      [
        {
          invoiceNumber: 'R-00101',
          date: '2026-11-20',
          amountCents: 120_070n,
          customerAccount: '10001',
          customerName: 'Wohnbau Nord eG',
        },
      ],
      accounts,
    )
    expect(bookings.map((b) => [b.amountCents, b.account, b.contraAccount, b.documentNo])).toEqual([
      [119_000n, '10001', '8400', 'R-00101'],
      [1_070n, '10001', '8300', 'R-00101'],
      [-119_000n, '10001', '8400', 'R-00102'],
      [120_070n, '1200', '10001', 'R-00101'],
    ])
    const file = datevBookingBatch(
      {
        consultantNumber: '1234567',
        clientNumber: '10001',
        fiscalYearStart: '2026-01-01',
        accountLength: 4,
        from: '2026-11-01',
        to: '2026-11-30',
        description: 'Ausgangsrechnungen November 2026 – sehr lange Bezeichnung',
        createdAt: new Date('2026-11-09T10:11:12.345Z'),
      },
      bookings,
    )
    const lines = file.trimEnd().split('\r\n')
    expect(lines[0]?.split(';').slice(0, 17)).toEqual([
      '"EXTF"',
      '700',
      '21',
      '"Buchungsstapel"',
      '13',
      '20261109101112345',
      '',
      '"RE"',
      '""',
      '""',
      '1234567',
      '10001',
      '20260101',
      '4',
      '20261101',
      '20261130',
      '"Ausgangsrechnungen November 20"',
    ])
    expect(lines[1]?.split(';')[0]).toBe('"Umsatz (ohne Soll/Haben-Kz)"')
    expect(lines[2]).toBe('1190,00;"S";"EUR";;;;10001;8400;;0911;"R-00101";"";;"Wohnbau Nord eG"')
    expect(lines[4]).toBe('1190,00;"H";"EUR";;;;10001;8400;;1011;"R-00102";"";;"Wohnbau Nord eG"')
    expect(lines[5]).toBe(
      '1200,70;"S";"EUR";;;;1200;10001;;2011;"R-00101";"";;"Zahlung Wohnbau Nord eG"',
    )
  })

  it('books accepted Kürzungen against revenue, split by tax rate', () => {
    const taxLines = [
      { category: 'S', ratePercent: '19.00', netCents: 100_000n, taxCents: 19_000n },
      { category: 'S', ratePercent: '7.00', netCents: 1_000n, taxCents: 70n },
    ]
    const base = {
      invoiceNumber: 'R-00101',
      date: '2026-11-21',
      customerAccount: '10001',
      customerName: 'Wohnbau Nord eG',
    }
    const bookings = datevBookings([], [], accounts, [
      { ...base, amountCents: 1_001n, taxLines },
      { ...base, amountCents: -1_001n, taxLines, reversal: true },
      { ...base, amountCents: 500n, taxLines: [] },
    ])
    expect(bookings.map((b) => [b.amountCents, b.account, b.contraAccount, b.text])).toEqual([
      [992n, '8400', '10001', 'Kürzung Wohnbau Nord eG'],
      [9n, '8300', '10001', 'Kürzung Wohnbau Nord eG'],
      [-992n, '8400', '10001', 'Storno Kürzung Wohnbau Nord eG'],
      [-9n, '8300', '10001', 'Storno Kürzung Wohnbau Nord eG'],
      [500n, '8400', '10001', 'Kürzung Wohnbau Nord eG'],
    ])
  })

  it('books received invoices per allocation with input tax key, § 13b and payments', () => {
    const incomingAccounts = {
      material: '3200',
      labor: '3100',
      equipment: '4960',
      subcontract: '3100',
      other: '4900',
      reverseCharge: '3120',
      creditor: '70000',
      bank: '1200',
    }
    const bookings = incomingBookings(
      [
        {
          invoiceNumber: 'RE-4711',
          date: '2026-11-03',
          supplierName: 'Baustoff Nord GmbH',
          creditNote: false,
          reverseCharge: false,
          allocations: [
            { costType: 'material', ratePercent: '19', netCents: 85_000n, taxCents: 16_150n },
            { costType: 'equipment', ratePercent: '7', netCents: 10_000n, taxCents: 700n },
            { costType: 'other', ratePercent: '0', netCents: 5_000n, taxCents: 0n },
          ],
        },
        {
          invoiceNumber: 'TS-117',
          date: '2026-11-04',
          supplierName: 'Trockenbau Süd GmbH',
          creditNote: false,
          reverseCharge: true,
          allocations: [
            { costType: 'subcontract', ratePercent: '0', netCents: 100_000n, taxCents: 0n },
          ],
        },
        {
          invoiceNumber: 'G-1',
          date: '2026-11-05',
          supplierName: 'Baustoff Nord GmbH',
          creditNote: true,
          reverseCharge: false,
          allocations: [
            { costType: 'material', ratePercent: '19', netCents: 1_000n, taxCents: 190n },
            { costType: 'labor', ratePercent: '19', netCents: 0n, taxCents: 0n },
          ],
        },
      ],
      [
        {
          invoiceNumber: 'RE-4711',
          date: '2026-11-10',
          supplierName: 'Baustoff Nord GmbH',
          amountCents: 116_850n,
        },
      ],
      incomingAccounts,
    )
    expect(bookings.map((b) => [b.amountCents, b.account, b.contraAccount, b.taxKey])).toEqual([
      [101_150n, '3200', '70000', '9'],
      [10_700n, '4960', '70000', '8'],
      [5_000n, '4900', '70000', undefined],
      [100_000n, '3120', '70000', undefined],
      [-1_190n, '3200', '70000', '9'],
      [116_850n, '70000', '1200', undefined],
    ])
    expect([inputTaxKey('19.00'), inputTaxKey('7'), inputTaxKey('0')]).toEqual([
      '9',
      '8',
      undefined,
    ])
    const file = datevBookingBatch(
      {
        consultantNumber: '1234567',
        clientNumber: '10001',
        fiscalYearStart: '2026-01-01',
        accountLength: 4,
        from: '2026-11-01',
        to: '2026-11-30',
        description: 'Eingangsrechnungen',
        createdAt: new Date('2026-11-09T10:11:12.345Z'),
      },
      bookings,
    )
    expect(file.split('\r\n')[2]).toBe(
      '1011,50;"S";"EUR";;;;3200;70000;"9";0311;"RE-4711";"";;"Baustoff Nord GmbH"',
    )
  })

  it('splits amounts exactly by weight', () => {
    expect(splitByWeights(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n])
    expect(splitByWeights(-100n, [1n, -1n, 1n])).toEqual([-34n, -33n, -33n])
    expect(splitByWeights(7n, [0n, 0n])).toEqual([7n, 0n])
    expect(splitByWeights(7n, [])).toEqual([])
    expect(splitByWeights(10n, [3n, 1n])).toEqual([8n, 2n])
  })

  it('derives accounts and fiscal years', () => {
    expect([customerAccount('K-10001'), customerAccount(null), customerAccount('')]).toEqual([
      '10001',
      '10000',
      '10000',
    ])
    expect(fiscalYearStart('2026-11-09', 1)).toBe('2026-01-01')
    expect(fiscalYearStart('2026-03-09', 7)).toBe('2025-07-01')
    expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01')
  })
})

describe('GoBD', () => {
  const table = {
    file: 'rechnungen.csv',
    name: 'Rechnungsausgang',
    description: 'Ausgangsrechnungen & Gutschriften',
    columns: [
      { name: 'Datum', type: 'date' as const },
      { name: 'Nummer', type: 'text' as const, primaryKey: true },
      { name: 'Netto', type: 'numeric' as const, accuracy: 2 },
      { name: 'Anzahl', type: 'numeric' as const },
    ],
    rows: [['09.11.2026', 'R-00101', '1000,00', 3]],
  }

  it('describes the tables in index.xml', () => {
    const xml = gobdIndexXml(
      { name: 'Muster <Bau>', location: 'Hannover', comment: 'Z3' },
      { from: '2026-01-01', to: '2026-12-31' },
      [table],
    )
    expect(xml).toContain('<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">')
    expect(xml).toContain('<Name>Muster &lt;Bau&gt;</Name>')
    expect(xml).toContain('<Range><From>01.01.2026</From><To>31.12.2026</To></Range>')
    expect(xml).toContain('<Description>Ausgangsrechnungen &amp; Gutschriften</Description>')
    const keyPos = xml.indexOf(
      '<VariablePrimaryKey><Name>Nummer</Name><AlphaNumeric/></VariablePrimaryKey>',
    )
    expect(keyPos).toBeGreaterThan(0)
    expect(
      xml.indexOf(
        '<VariableColumn><Name>Datum</Name><Date><Format>DD.MM.YYYY</Format></Date></VariableColumn>',
      ),
    ).toBeGreaterThan(keyPos)
    expect(xml).toContain('<Numeric><Accuracy>2</Accuracy></Numeric>')
    expect(xml).toContain('<VariableColumn><Name>Anzahl</Name><Numeric></Numeric></VariableColumn>')
  })

  it('writes data files without header, primary key first', () => {
    expect(gobdTableCsv(table)).toBe('"R-00101";"09.11.2026";"1000,00";3\r\n')
  })
})
