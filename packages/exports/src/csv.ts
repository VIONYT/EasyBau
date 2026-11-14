/** CSV for German tools (Excel, IDEA, DATEV): semicolon, CRLF, quotes doubled. */
export type CsvValue = string | number | null | undefined

export function csvField(value: CsvValue, quoteAlways = false): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (quoteAlways || /[";\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function csvLine(values: readonly CsvValue[], quoteText = false): string {
  return values.map((v) => csvField(v, quoteText && typeof v === 'string')).join(';')
}

export function csv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return `${[csvLine(header), ...rows.map((r) => csvLine(r))].join('\r\n')}\r\n`
}

/** Cents as German amount without thousands separator: 123456 → "1234,56", -5 → "-0,05". */
export function germanAmount(cents: number | bigint | string): string {
  const value = BigInt(cents)
  const negative = value < 0n
  const abs = negative ? -value : value
  return `${negative ? '-' : ''}${abs / 100n},${String(abs % 100n).padStart(2, '0')}`
}

/** ISO date (YYYY-MM-DD) → DD.MM.YYYY. */
export function germanDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

/**
 * Windows-1252 (ANSI) as expected by DATEV. Latin-1 characters map directly, the euro sign to
 * 0x80, typographic quotes and dashes to their 1252 codes; anything else becomes "?".
 */
const CP1252_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '–': 0x96,
  '—': 0x97,
}

export function encodeWindows1252(text: string): Buffer {
  const bytes: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code)
    else bytes.push(CP1252_EXTRA[ch] ?? 0x3f)
  }
  return Buffer.from(bytes)
}

/**
 * Reads CSV as written by Excel/LibreOffice in Germany: separator `;` (or `,`/tab, detected from
 * the header line), fields in double quotes with doubled quotes inside, CRLF or LF, optional
 * UTF-8 BOM. Returns the rows as arrays of strings; empty lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, '')
  const firstLine = input.slice(0, input.search(/\r?\n|$/))
  const counts = [';', ',', '\t'].map((s) => ({ s, n: firstLine.split(s).length }))
  const separator = counts.reduce((best, c) => (c.n > best.n ? c : best)).s
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === separator) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      if (row.some((v) => v !== '')) rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  row.push(field)
  if (row.some((v) => v !== '')) rows.push(row)
  return rows
}
