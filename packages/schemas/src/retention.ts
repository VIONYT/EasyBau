import { z } from 'zod'
import { id } from './common.js'

/**
 * Aufbewahrung (C.12): finalized documents whose retention period has ended can be anonymised
 * after an approval (number, dates and amounts stay; recipient, texts and originals go).
 */

/** A finalized document whose retention period has ended and that is not anonymised yet. */
export interface RetentionDueDocument {
  id: string
  type: string
  number: string
  documentDate: string
  retentionEnd: string
  recipient: string | null
  projectNumber: string | null
  originals: number
}

export interface RetentionOverview {
  /** Years for invoices and credit notes (Buchungsbelege, 8–30); other documents: 6 years. */
  retentionYears: number
  due: RetentionDueDocument[]
  /** More due documents than listed (the list shows the oldest 500). */
  more: boolean
}

export const retentionSettingsRequest = z.object({
  retentionYears: z
    .number('Bitte eine Zahl eingeben.')
    .int('Bitte ganze Jahre angeben.')
    .min(8, 'Mindestens 8 Jahre (§ 147 AO).')
    .max(30, 'Höchstens 30 Jahre.'),
})
export type RetentionSettingsRequest = z.infer<typeof retentionSettingsRequest>

export const purgeDocumentsRequest = z.object({
  documentIds: z
    .array(id)
    .min(1, 'Bitte mindestens einen Beleg auswählen.')
    .max(100, 'Höchstens 100 Belege auf einmal.'),
  /** The caller confirms that the anonymisation cannot be undone. */
  confirm: z.literal(true, 'Bitte bestätigen, dass das Anonymisieren endgültig ist.'),
})
export type PurgeDocumentsRequest = z.infer<typeof purgeDocumentsRequest>

export interface PurgeDocumentsResult {
  purged: number
  failed: { id: string; message: string }[]
}

/** Löschprotokoll: one approved and anonymised document. */
export interface PurgeLogEntry {
  documentId: string
  type: string
  number: string
  documentDate: string
  retentionEnd: string
  approvedBy: string | null
  approvedAt: string
  purgedAt: string | null
  originals: number
  /** Originals still in the working copy (deleted on the next approval or by retrying). */
  filesPending: number
  /** Originals still in the WORM archive (removed by the operator: infra/archive-purge.sh). */
  archivePending: number
}
