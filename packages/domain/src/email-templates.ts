/**
 * E-Mail-Vorlagen for sending documents (P2.1): subject and text per document type with German
 * placeholders. Filling is plain text replacement – nothing is evaluated.
 */

export const EMAIL_DOCUMENT_TYPES = [
  'quote',
  'cost_estimate',
  'order_confirmation',
  'change_order',
  'delivery_note',
  'invoice',
  'credit_note',
] as const
export type EmailDocumentType = (typeof EMAIL_DOCUMENT_TYPES)[number]

export interface EmailTemplate {
  subject: string
  body: string
}

/** Placeholders a template may use (shown in the settings). */
export const EMAIL_PLACEHOLDERS = [
  'Dokument',
  'Nummer',
  'Datum',
  'Betrag',
  'Fällig',
  'Projekt',
  'Kunde',
  'Firma',
] as const
export type EmailPlaceholder = (typeof EMAIL_PLACEHOLDERS)[number]

const GREETING = 'Sehr geehrte Damen und Herren,'
const CLOSING = 'Mit freundlichen Grüßen\n{Firma}'

const offer = (what: string): EmailTemplate => ({
  subject: `{Dokument} {Nummer} – {Projekt}`,
  body: `${GREETING}\n\nanbei erhalten Sie ${what} {Nummer} vom {Datum} für {Projekt}.\n\nFür Rückfragen stehen wir Ihnen gern zur Verfügung.\n\n${CLOSING}`,
})

export const DEFAULT_EMAIL_TEMPLATES: Record<EmailDocumentType, EmailTemplate> = {
  quote: offer('unser Angebot'),
  cost_estimate: offer('unseren Kostenvoranschlag'),
  order_confirmation: {
    subject: '{Dokument} {Nummer} – {Projekt}',
    body: `${GREETING}\n\nvielen Dank für Ihren Auftrag. Anbei erhalten Sie unsere Auftragsbestätigung {Nummer} vom {Datum} für {Projekt}.\n\n${CLOSING}`,
  },
  change_order: offer('unser Nachtragsangebot'),
  delivery_note: {
    subject: '{Dokument} {Nummer} – {Projekt}',
    body: `${GREETING}\n\nanbei erhalten Sie unseren Lieferschein {Nummer} vom {Datum} für {Projekt}.\n\n${CLOSING}`,
  },
  invoice: {
    subject: '{Dokument} {Nummer} – {Firma}',
    body: `${GREETING}\n\nanbei erhalten Sie unsere {Dokument} {Nummer} vom {Datum} für {Projekt} über {Betrag}. Bitte überweisen Sie den Betrag bis zum {Fällig}.\n\n${CLOSING}`,
  },
  credit_note: {
    subject: '{Dokument} {Nummer} – {Firma}',
    body: `${GREETING}\n\nanbei erhalten Sie unsere Gutschrift {Nummer} vom {Datum} über {Betrag}.\n\n${CLOSING}`,
  },
}

/** Replaces {Platzhalter}; unknown placeholders stay as they are (visible to the user). */
export function fillEmailTemplate(
  text: string,
  values: Partial<Record<EmailPlaceholder, string | null>>,
): string {
  return text.replace(/\{([A-Za-zÄÖÜäöüß]+)\}/g, (match, name: string) => {
    const value = values[name as EmailPlaceholder]
    return value === undefined || value === null ? match : value
  })
}
