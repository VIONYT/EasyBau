/**
 * Briefpapier nach DIN 5008, Form B (A4, 210 × 297 mm). All positions in millimetres from the
 * top left corner of the page. The layout is designed in the web app (WYSIWYG editor) and frozen
 * with every finalized document (rule 4).
 */

/** Fixed zones of DIN 5008 Form B. */
export const DIN5008B = {
  page: { width: 210, height: 297 }, // A4
  /** Briefkopf: free area for logo and company texts. */
  header: { height: 45 },
  /** Anschriftfeld (window envelope DL/C5/C6): 85 × 45 mm, text inset 5 mm. */
  address: { x: 20, y: 45, width: 85, height: 45, inset: 5, noteZone: 17.7 },
  /** Informationsblock (Nummer, Datum, …). */
  info: { x: 125, y: 50, width: 75 },
  /** Start of the letter text (Betreff) and text margins. */
  body: { y: 98.46, left: 25, right: 20 },
  /** Falz- und Lochmarken. */
  marks: { fold1: 105, fold2: 210, hole: 148.5 },
  /** Fußzeile (Firmen-, Bank- und Registerangaben). */
  footer: { y: 272, height: 20 },
} as const

export interface LetterheadText {
  id: string
  /** Position and width in mm (inside the Briefkopf). */
  x: number
  y: number
  width: number
  /** Text with placeholders such as {Firma}; line breaks allowed. */
  text: string
  /** Point size. */
  fontSize: number
  bold: boolean
  align: 'left' | 'center' | 'right'
  color: string
}

/** Paper format: A4 (210 × 297 mm), the standard in Europe and the basis of DIN 5008. */
export const PAPER_FORMATS = { A4: { width: 210, height: 297 } } as const
export type PaperFormat = keyof typeof PAPER_FORMATS

export interface Letterhead {
  version: 1
  paper: PaperFormat
  font: 'sans' | 'serif'
  /** Accent colour (#rrggbb) for title, lines and table header. */
  accentColor: string
  logo: { assetId: string; x: number; y: number; width: number } | null
  texts: LetterheadText[]
  /** Rücksendeangabe above the address, e.g. „{Firma} · {Straße} · {PLZ} {Ort}“. */
  senderLine: string
  /** Footer columns (1–4), each a text with placeholders. */
  footer: string[]
  foldMarks: boolean
}

/** Placeholders that can be used in letterhead texts (key → German label). */
export const LETTERHEAD_FIELDS = [
  ['Firma', 'Firmenname'],
  ['Straße', 'Straße'],
  ['PLZ', 'Postleitzahl'],
  ['Ort', 'Ort'],
  ['Telefon', 'Telefon'],
  ['E-Mail', 'E-Mail'],
  ['Web', 'Website'],
  ['USt-IdNr', 'USt-IdNr.'],
  ['Steuernummer', 'Steuernummer'],
  ['Registergericht', 'Registergericht'],
  ['Registernummer', 'Registernummer'],
  ['Geschäftsführung', 'Geschäftsführung'],
  ['Bank', 'Bank'],
  ['IBAN', 'IBAN'],
  ['BIC', 'BIC'],
] as const

export type LetterheadField = (typeof LETTERHEAD_FIELDS)[number][0]
export type LetterheadValues = Partial<Record<LetterheadField, string | null>>

const PLACEHOLDER = /\{([^{}]+)\}/g
const KNOWN = new Map<string, LetterheadField>(
  LETTERHEAD_FIELDS.map(([key]) => [key.toLowerCase(), key]),
)

/**
 * Fills placeholders. A line whose placeholders are all empty is left out completely, so
 * „Tel. {Telefon}“ disappears when no phone number is set; empty parts between „·“ are dropped.
 * Unknown placeholders stay visible.
 */
export function fillPlaceholders(text: string, values: LetterheadValues): string {
  return text
    .split('\n')
    .flatMap((line) => {
      let used = 0
      let filled = 0
      const result = line.replace(PLACEHOLDER, (match, name: string) => {
        const key = KNOWN.get(name.trim().toLowerCase())
        if (!key) return match
        used += 1
        const value = values[key]?.trim() ?? ''
        if (value) filled += 1
        return value
      })
      if (used > 0 && filled === 0) return []
      // „{E-Mail} · {Web}“ with an empty e-mail: no dangling separator.
      return [
        result.includes('·')
          ? result
              .split('·')
              .map((part) => part.trim())
              .filter(Boolean)
              .join(' · ')
          : result.trimEnd(),
      ]
    })
    .join('\n')
}

/** DE89370400440532013000 → „DE89 3704 0044 0532 0130 00“ (print format). */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ')
}

/** Default letterhead: company name top right, sender line, three footer columns. */
export function defaultLetterhead(): Letterhead {
  return {
    version: 1,
    paper: 'A4',
    font: 'sans',
    accentColor: '#0f4c5c',
    logo: null,
    texts: [
      {
        id: 'name',
        x: 110,
        y: 15,
        width: 80,
        text: '{Firma}',
        fontSize: 16,
        bold: true,
        align: 'right',
        color: '#0f4c5c',
      },
      {
        id: 'contact',
        x: 110,
        y: 24,
        width: 80,
        text: '{Straße} · {PLZ} {Ort}\nTel. {Telefon}\n{E-Mail} · {Web}',
        fontSize: 8,
        bold: false,
        align: 'right',
        color: '#333333',
      },
    ],
    senderLine: '{Firma} · {Straße} · {PLZ} {Ort}',
    footer: [
      '{Firma}\n{Straße}\n{PLZ} {Ort}',
      'Tel. {Telefon}\n{E-Mail}\n{Web}',
      '{Bank}\nIBAN {IBAN}\nBIC {BIC}',
      'Geschäftsführung: {Geschäftsführung}\n{Registergericht} {Registernummer}\nSt.-Nr. {Steuernummer}\nUSt-IdNr. {USt-IdNr}',
    ],
    foldMarks: true,
  }
}

/** Keeps an element inside the page (positions in mm). */
export function clampToPage(
  x: number,
  y: number,
  width: number,
  maxY: number = DIN5008B.header.height,
): { x: number; y: number } {
  const round = (v: number) => Math.round(v * 10) / 10
  return {
    x: round(Math.min(Math.max(x, 0), DIN5008B.page.width - width)),
    y: round(Math.min(Math.max(y, 0), maxY)),
  }
}
