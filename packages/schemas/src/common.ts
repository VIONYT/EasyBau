import { z } from 'zod'

/** Trimmed, non-empty text with a maximum length. Empty strings become undefined for optional fields. */
export const text = (max = 200) =>
  z.string().trim().min(1, 'Darf nicht leer sein.').max(max, `Höchstens ${max} Zeichen.`)
export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `Höchstens ${max} Zeichen.`)
    .transform((v) => (v === '' ? null : v))
    .nullish()

export const id = z.uuid('Ungültige ID.')
export const isoDate = z.iso.date('Datum im Format JJJJ-MM-TT erwartet.')
export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Ländercode mit zwei Buchstaben erwartet (z. B. DE).')
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Ungültige E-Mail-Adresse.'))
  .pipe(z.string().max(254))
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #RRGGBB erwartet.')

export const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export interface Page<T> {
  items: T[]
  /** Opaque cursor for the next page; null on the last page. */
  nextCursor: string | null
}

/** RFC 9457 problem details as returned by the API. */
export interface Problem {
  type: string
  title: string
  status: number
  detail: string
  /** Field errors for validation problems: path → German message. */
  errors?: Record<string, string>
}
