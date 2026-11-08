/**
 * DATANORM 4 / 5 reader (Großhandels-Artikelstamm), pure and streaming-friendly.
 *
 * Records are semicolon separated, one per line. Supported record types:
 *   V  Vorlaufsatz:  V;Version;Datum;Info 1 (Lieferant);Info 2;Info 3;Währung
 *   A  Artikel:      A;VKZ;Artikelnr;Textkz;Kurztext 1;Kurztext 2;Preiskz;Preiseinheit;Mengeneinheit;
 *                    Preis;Rabattgruppe;Warengruppe;Langtextschlüssel
 *   B  Artikel 2:    B;VKZ;Artikelnr;Matchcode;… (EAN is recognised by its format)
 *   T  Langtext:     T;VKZ;Textschlüssel;Zeilennr;Kz;Text[;Zeilennr;Kz;Text]
 *   P  Preis:        P;VKZ;Artikelnr;Preiskz;Preis[;…]
 * VKZ (Verarbeitungskennzeichen): N = neu, A = ändern, L = löschen.
 * Unknown record types are counted and skipped. DATANORM 3 (fixed record length) is rejected.
 */

import { Decimal, toDecimal } from '../decimal.js'

export type DatanormAction = 'new' | 'change' | 'delete'

export interface DatanormHeader {
  version: string
  date: string | null
  supplier: string | null
  info: string[]
  currency: string
}

export interface DatanormArticle {
  action: DatanormAction
  articleNo: string
  shortText: string
  /** Price as listed (list price or net price, see priceKind), for `priceUnit` units, in cents. */
  priceCents: string
  priceKind: 'list' | 'net'
  /** Price refers to 1, 10, 100 or 1000 units. */
  priceUnit: number
  /** Unit as written in the file (e.g. "Stck", "M2"). */
  unitRaw: string
  /** Matching system unit symbol, or null. */
  unitSymbol: string | null
  discountGroup: string | null
  productGroup: string | null
  longTextKey: string | null
}

export interface DatanormArticleExtra {
  action: DatanormAction
  articleNo: string
  matchcode: string | null
  ean: string | null
}

export interface DatanormText {
  key: string
  line: number
  text: string
}

export interface DatanormPrice {
  articleNo: string
  priceKind: 'list' | 'net'
  priceCents: string
}

export type DatanormRecord =
  | { type: 'header'; header: DatanormHeader }
  | { type: 'article'; article: DatanormArticle }
  | { type: 'extra'; extra: DatanormArticleExtra }
  | { type: 'text'; texts: DatanormText[] }
  | { type: 'price'; prices: DatanormPrice[] }
  | { type: 'skip'; recordType: string }

export class DatanormError extends Error {
  override name = 'DatanormError'
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `Zeile ${line}: ${message}`)
  }
}

// ---- Character set --------------------------------------------------------------------------------

/** Code page 850 (DOS, Western Europe), bytes 0x80–0xFF. Most DATANORM files use it. */
const CP850 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ '

export type DatanormEncoding = 'utf-8' | 'cp850' | 'latin1'

/**
 * Guesses the character set from a sample: valid UTF-8 with multi-byte sequences → UTF-8;
 * otherwise CP850 if its umlaut bytes (0x81 ü, 0x84 ä, 0x94 ö, 0xE1 ß …) dominate, else Latin-1.
 */
export function detectEncoding(sample: Uint8Array): DatanormEncoding {
  let high = 0
  let cp850 = 0
  let latin1 = 0
  for (const byte of sample) {
    if (byte < 0x80) continue
    high += 1
    if ([0x81, 0x84, 0x8e, 0x94, 0x99, 0x9a, 0xe1].includes(byte)) cp850 += 1
    if ([0xc4, 0xd6, 0xdc, 0xdf, 0xe4, 0xf6, 0xfc].includes(byte)) latin1 += 1
  }
  if (high === 0) return 'utf-8'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return 'utf-8'
  } catch {
    // Not UTF-8: a truncated multi-byte sequence at the very end is ignored below.
  }
  if (looksLikeUtf8(sample)) return 'utf-8'
  return cp850 >= latin1 ? 'cp850' : 'latin1'
}

/** UTF-8 except for an incomplete sequence at the end of the sample. */
function looksLikeUtf8(sample: Uint8Array): boolean {
  for (let cut = 1; cut <= 3 && cut < sample.length; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - cut))
      return true
    } catch {
      // try a shorter sample
    }
  }
  return false
}

/** Decodes bytes; for UTF-8 use a streaming TextDecoder instead (multi-byte sequences). */
export function decodeBytes(
  bytes: Uint8Array,
  encoding: Exclude<DatanormEncoding, 'utf-8'>,
): string {
  let result = ''
  for (const byte of bytes) {
    result +=
      byte < 0x80 || encoding === 'latin1'
        ? String.fromCharCode(byte)
        : (CP850[byte - 0x80] as string)
  }
  return result
}

// ---- Records ----------------------------------------------------------------------------------------

const clean = (value: string | undefined) => (value ?? '').trim()
const orNull = (value: string | undefined) => clean(value) || null

const ACTIONS: Record<string, DatanormAction> = { N: 'new', A: 'change', L: 'delete', '': 'new' }

function actionOf(value: string | undefined, line: number): DatanormAction {
  const action = ACTIONS[clean(value).toUpperCase()]
  if (!action) throw new DatanormError(`Unbekanntes Verarbeitungskennzeichen „${value}“.`, line)
  return action
}

const PRICE_UNITS: Record<string, number> = { '': 1, '0': 1, '1': 10, '2': 100, '3': 1000 }

/**
 * Price field: whole cents without separator ("1234" = 12,34 €) or a decimal amount in euros
 * ("12,34" / "12.34"). Returns exact cents as text (may have fractions of a cent).
 */
export function parseDatanormPrice(value: string, line?: number): string {
  const text = value.trim()
  if (!text) return '0'
  if (/^\d+$/.test(text)) return String(Number.parseInt(text, 10))
  if (/^\d+[.,]\d+$/.test(text)) return toDecimal(text).mul(100).toString()
  throw new DatanormError(`Ungültiger Preis „${value}“.`, line)
}

/** DATANORM units (as used by wholesalers) → system unit symbols (DESIGN.md §4.2.1). */
const UNIT_MAP: Record<string, string> = {
  stk: 'Stk.',
  stck: 'Stk.',
  st: 'Stk.',
  'st.': 'Stk.',
  stück: 'Stk.',
  stueck: 'Stk.',
  pce: 'Stk.',
  pcs: 'Stk.',
  m: 'm',
  mtr: 'm',
  lfm: 'Lfm',
  lfdm: 'Lfm',
  km: 'km',
  m2: 'm²',
  'm²': 'm²',
  qm: 'm²',
  m3: 'm³',
  'm³': 'm³',
  cbm: 'm³',
  l: 'l',
  ltr: 'l',
  liter: 'l',
  kg: 'kg',
  t: 't',
  to: 't',
  std: 'Std',
  h: 'Std',
  min: 'min',
  pak: 'Pkg',
  pkg: 'Pkg',
  pack: 'Pkg',
  pck: 'Pkg',
  eim: 'Eimer',
  eimer: 'Eimer',
  sack: 'Sack',
  sa: 'Sack',
  sck: 'Sack',
  rol: 'Rolle',
  rolle: 'Rolle',
  rll: 'Rolle',
  tub: 'Tube',
  tube: 'Tube',
  psch: 'psch',
  pau: 'psch',
}

export function mapDatanormUnit(raw: string): string | null {
  return UNIT_MAP[raw.trim().toLowerCase()] ?? null
}

/** Parses one line (without line break). Empty lines yield null. */
export function parseDatanormLine(text: string, line: number): DatanormRecord | null {
  const raw = text.replace(/\r$/, '')
  if (!raw.trim()) return null
  if (!raw.includes(';')) {
    throw new DatanormError(
      'Keine DATANORM-4/5-Datei (Felder mit Semikolon). DATANORM 3 mit fester Satzlänge wird nicht unterstützt.',
      line,
    )
  }
  const f = raw.split(';')
  const type = clean(f[0]).toUpperCase()
  switch (type) {
    case 'V':
      return {
        type: 'header',
        header: {
          version: clean(f[1]),
          date: orNull(f[2]),
          supplier: orNull(f[3]),
          info: [f[3], f[4], f[5]].map(clean).filter(Boolean),
          currency: clean(f[6]).toUpperCase() || 'EUR',
        },
      }
    case 'A': {
      const articleNo = clean(f[2])
      if (!articleNo) throw new DatanormError('Artikelnummer fehlt.', line)
      const priceUnit = PRICE_UNITS[clean(f[7])]
      if (priceUnit === undefined)
        throw new DatanormError(`Unbekannte Preiseinheit „${f[7]}“.`, line)
      const unitRaw = clean(f[8])
      return {
        type: 'article',
        article: {
          action: actionOf(f[1], line),
          articleNo,
          shortText: [clean(f[4]), clean(f[5])].filter(Boolean).join(' ') || articleNo,
          priceKind: clean(f[6]) === '2' ? 'net' : 'list',
          priceUnit,
          unitRaw,
          unitSymbol: mapDatanormUnit(unitRaw),
          priceCents: parseDatanormPrice(f[9] ?? '', line),
          discountGroup: orNull(f[10]),
          productGroup: orNull(f[11]),
          longTextKey: orNull(f[12]),
        },
      }
    }
    case 'B': {
      const articleNo = clean(f[2])
      if (!articleNo) throw new DatanormError('Artikelnummer fehlt.', line)
      const ean =
        f
          .slice(3)
          .map(clean)
          .find((v) => /^(\d{8}|\d{13})$/.test(v)) ?? null
      return {
        type: 'extra',
        extra: { action: actionOf(f[1], line), articleNo, matchcode: orNull(f[3]), ean },
      }
    }
    case 'T': {
      const key = clean(f[2])
      if (!key) throw new DatanormError('Textschlüssel fehlt.', line)
      const texts: DatanormText[] = []
      // Groups of (Zeilennummer; Kennzeichen; Text), usually two per record.
      for (let i = 3; i < f.length; i += 3) {
        const number = Number.parseInt(clean(f[i]), 10)
        const value = (f[i + 2] ?? '').replace(/\s+$/, '')
        if (Number.isNaN(number)) continue
        texts.push({ key, line: number, text: value })
      }
      return { type: 'text', texts }
    }
    case 'P': {
      const prices: DatanormPrice[] = []
      // P;VKZ;(Artikelnr;Preiskz;Preis;Rabattkz;Rabatt;Rabattkz;Rabatt;Rabattkz;Rabatt) × up to 3
      for (let i = 2; i < f.length; i += 9) {
        const articleNo = clean(f[i])
        if (!articleNo) continue
        prices.push({
          articleNo,
          priceKind: clean(f[i + 1]) === '2' ? 'net' : 'list',
          priceCents: parseDatanormPrice(f[i + 2] ?? '', line),
        })
      }
      return { type: 'price', prices }
    }
    default:
      return { type: 'skip', recordType: type }
  }
}

/** Splits a stream of text chunks into lines, keeping an incomplete last line for the next chunk. */
export class LineSplitter {
  private rest = ''
  private count = 0

  push(chunk: string): { text: string; line: number }[] {
    const parts = (this.rest + chunk).split('\n')
    this.rest = parts.pop() as string
    return parts.map((text) => ({ text, line: ++this.count }))
  }

  end(): { text: string; line: number }[] {
    const last = this.rest
    this.rest = ''
    return last ? [{ text: last, line: ++this.count }] : []
  }
}

/**
 * Price for ONE unit in cents (exact): list price minus discount, divided by the price unit.
 * E.g. 12,34 € per 100 Stück list price with 30 % discount → 8,638 ct per piece.
 */
export function unitCostCents(
  article: Pick<DatanormArticle, 'priceCents' | 'priceUnit' | 'priceKind'>,
  discountPercent: string | number = 0,
): Decimal {
  const price = toDecimal(article.priceCents).div(article.priceUnit)
  if (article.priceKind === 'net') return price
  return price.mul(new Decimal(100).minus(toDecimal(discountPercent)).div(100))
}

/** Joins the lines of a long text in order of their line numbers. */
export function joinLongText(lines: readonly { line: number; text: string }[]): string {
  return [...lines]
    .sort((a, b) => a.line - b.line)
    .map((l) => l.text)
    .join('\n')
    .trim()
}
