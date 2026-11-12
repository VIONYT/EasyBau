import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_DOCUMENT_TYPES,
  EMAIL_PLACEHOLDERS,
  fillEmailTemplate,
} from './email-templates.js'

describe('E-Mail-Vorlagen', () => {
  it('has a template for every document type that uses only known placeholders', () => {
    for (const type of EMAIL_DOCUMENT_TYPES) {
      const template = DEFAULT_EMAIL_TEMPLATES[type]
      const used = `${template.subject} ${template.body}`.match(/\{[^}]+\}/g) ?? []
      for (const placeholder of used) {
        expect(EMAIL_PLACEHOLDERS).toContain(placeholder.slice(1, -1))
      }
      expect(template.body).toContain('{Firma}')
    }
  })

  it('fills placeholders and keeps unknown or missing ones visible', () => {
    expect(
      fillEmailTemplate('{Dokument} {Nummer} über {Betrag}, fällig {Fällig} {Unbekannt} {Kunde}', {
        Dokument: 'Rechnung',
        Nummer: 'R-1',
        Betrag: '1.190,00 €',
        Fällig: '16.11.2026',
        Kunde: null,
      }),
    ).toBe('Rechnung R-1 über 1.190,00 €, fällig 16.11.2026 {Unbekannt} {Kunde}')
    // Values are inserted as text, never interpreted again.
    expect(fillEmailTemplate('{Kunde}', { Kunde: '{Firma}' })).toBe('{Firma}')
  })
})
