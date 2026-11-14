import { z } from 'zod'
import { email, id, text } from './common.js'
import { DOCUMENT_TYPES } from './constants.js'

export interface EmailSettings {
  /** SMTP is configured on the server (SMTP_HOST, SMTP_FROM in .env). */
  enabled: boolean
  from: string | null
}

export const testEmailRequest = z.object({ to: email.optional() })

export interface EmailMessageSummary {
  id: string
  kind: 'invitation' | 'test' | 'document' | 'dunning' | 'password_reset' | 'email_verify'
  toAddress: string
  subject: string
  status: 'queued' | 'sending' | 'sent' | 'failed'
  attempts: number
  lastError: string | null
  createdAt: string
  sentAt: string | null
}

// ---- Dokumente per E-Mail (P2.1) ----------------------------------------------------------------

const recipients = z.array(email).max(10, 'Höchstens 10 Empfänger.').default([])

export const sendDocumentEmailRequest = z.object({
  to: email,
  cc: recipients,
  bcc: recipients,
  subject: text(300),
  text: text(20_000),
  /** Rechnungen: attach the archived XRechnung XML(s) as well. */
  attachXrechnung: z.boolean().default(false),
  /** Company files to attach (AGB …); omitted = the automatic attachments of the document type. */
  fileIds: z.array(id).max(10, 'Höchstens 10 Anhänge.').optional(),
})
export type SendDocumentEmailRequest = z.infer<typeof sendDocumentEmailRequest>

export interface DocumentEmailEntry {
  id: string
  to: string
  cc: string[]
  bcc: string[]
  subject: string
  status: 'queued' | 'sending' | 'sent' | 'failed'
  attempts: number
  lastError: string | null
  attachments: string[]
  createdAt: string
  sentAt: string | null
  createdBy: string | null
}

/** Prefilled dialog „Per E-Mail senden“ and the history of the document. */
export interface DocumentEmailDraft {
  /** SMTP is configured. */
  enabled: boolean
  /** Why the document cannot be sent (draft, cancelled …); null = ok. */
  blocked: string | null
  to: string | null
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  /** Attached originals (always) and the XRechnung that can be added. */
  attachments: { filename: string; kind: 'pdf' | 'xrechnung' }[]
  xrechnung: { available: boolean; recommended: boolean; filenames: string[] }
  /** Company files (AGB …): all uploaded ones, `selected` = automatic attachment of this type. */
  files: { id: string; filename: string; sizeBytes: number; selected: boolean }[]
  history: DocumentEmailEntry[]
}

const templateText = z.object({ subject: text(300), body: text(8000) })

export const emailTemplatesRequest = z.object({
  /** Copy of every document e-mail, e.g. to the office (Blindkopie). */
  bcc: email.nullable(),
  templates: z.partialRecord(z.enum(DOCUMENT_TYPES), templateText),
})
export type EmailTemplatesRequest = z.infer<typeof emailTemplatesRequest>

export interface EmailTemplateSettings {
  bcc: string | null
  /** Effective template per document type (own text or default). */
  templates: Record<
    (typeof DOCUMENT_TYPES)[number],
    { subject: string; body: string; custom: boolean }
  >
  /** Built-in texts, for „Standardtext wiederherstellen“. */
  defaults: Record<(typeof DOCUMENT_TYPES)[number], { subject: string; body: string }>
  placeholders: string[]
}
