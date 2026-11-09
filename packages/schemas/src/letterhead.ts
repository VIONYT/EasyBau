import { z } from 'zod'
import { id } from './common.js'

/** Briefpapier (DIN 5008 Form B), designed in the WYSIWYG editor. Positions in mm. */
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #RRGGBB.')
const mm = (max: number) => z.number().min(0).max(max)

export const letterheadText = z.object({
  id: z.string().min(1).max(40),
  x: mm(210),
  y: mm(45),
  width: z.number().min(10).max(210),
  text: z.string().max(1000),
  fontSize: z.number().min(6).max(36),
  bold: z.boolean(),
  align: z.enum(['left', 'center', 'right']),
  color,
})

export const letterheadRequest = z.object({
  version: z.literal(1),
  /** Papierformat: A4 (DIN 5008, Standard in Europa). */
  paper: z.literal('A4').default('A4'),
  font: z.enum(['sans', 'serif']),
  accentColor: color,
  logo: z
    .object({ assetId: id, x: mm(210), y: mm(45), width: z.number().min(5).max(210) })
    .nullable(),
  texts: z.array(letterheadText).max(12),
  senderLine: z.string().max(200),
  footer: z.array(z.string().max(500)).min(0).max(4),
  foldMarks: z.boolean(),
})
export type LetterheadLayout = z.infer<typeof letterheadRequest>

export interface LetterheadSettings {
  layout: LetterheadLayout
  /** Values of the placeholders ({Firma}, {IBAN} …) from Einstellungen › Firma. */
  values: Record<string, string | null>
}

// ---- Handschriftliche Unterschrift -------------------------------------------------------------

/** The signature a user keeps in the account (drawn once, reused when signing). */
export interface MySignature {
  assetId: string
  url: string
  updatedAt: string
}

export const saveMySignatureRequest = z.object({ assetId: id })

export interface UploadedSignature {
  assetId: string
  url: string
}
