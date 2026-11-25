import {
  DIN5008B,
  defaultLetterhead,
  fillPlaceholders,
  footerColumnWeights,
  type Letterhead,
  type LetterheadValues,
} from '@easybau/domain'
import type { LetterPdfInput } from './types.js'

export interface LogoPosition {
  assetId: string
  x: number
  y: number
  width: number
  maxHeight: number
}

/** Briefkopf, Anschriftfeld, Infoblock and footer of a letter (DIN 5008 Form B, A4). */
export function letterFrame(options: {
  issuerName: string
  layout: Letterhead | undefined
  values: LetterheadValues
  recipient: string[]
  info: { label: string; value: string }[]
  title: string
  watermark: string | null
}): Omit<LetterPdfInput, 'logo' | 'body'> & { logoPosition: LogoPosition | null } {
  const layout = options.layout ?? defaultLetterhead()
  const { values } = options
  const footer = layout.footer
    .map((c) => fillPlaceholders(c, values))
    .filter((c) => c.trim() !== '')
  return {
    title: options.title,
    author: options.issuerName,
    font: layout.font,
    accent: layout.accentColor,
    foldMarks: layout.foldMarks,
    watermark: options.watermark,
    logoPosition: layout.logo
      ? { ...layout.logo, maxHeight: Math.max(DIN5008B.header.height - layout.logo.y, 5) }
      : null,
    texts: layout.texts
      .map((x) => ({ ...x, text: fillPlaceholders(x.text, values) }))
      .filter((x) => x.text.trim() !== '')
      .map(({ id: _, ...x }) => x),
    senderLine: fillPlaceholders(layout.senderLine, values),
    recipient: options.recipient,
    info: options.info,
    footer,
    footerWeights: footerColumnWeights(footer),
  }
}

/** Empty body parts for letters that only use building blocks. */
export const EMPTY_BODY = {
  intro: null,
  columns: [],
  items: [],
  deductions: null,
  totals: [],
  notes: [],
  closing: null,
} satisfies Partial<LetterPdfInput['body']>
