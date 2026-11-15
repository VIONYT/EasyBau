import { describe, expect, it } from 'vitest'
import { type CompanyNoticeInput, companyNotices } from './company-notices.js'

const complete: CompanyNoticeInput['company'] = {
  name: 'Muster Bau GmbH',
  street: 'Hauptstr. 1',
  postalCode: '12345',
  city: 'Musterstadt',
  taxNumber: '12/345/67890',
  vatId: null,
  iban: 'DE02120300000000202051',
  email: 'info@example.test',
  federalState: 'BY',
}

describe('Hinweisleiste', () => {
  it('is empty when everything is there', () => {
    expect(
      companyNotices({ company: complete, canManageCompany: true, emailVerified: true }),
    ).toEqual([])
    expect(
      companyNotices({ company: complete, canManageCompany: true, emailVerified: null }),
    ).toEqual([])
  })

  it('lists missing company data for people who can fix it', () => {
    const empty = {
      name: ' ',
      street: null,
      postalCode: null,
      city: null,
      taxNumber: null,
      vatId: null,
      iban: null,
      email: null,
      federalState: null,
    }
    const notices = companyNotices({ company: empty, canManageCompany: true, emailVerified: false })
    expect(notices.map((n) => [n.key, n.severity])).toEqual([
      ['company_address', 'required'],
      ['company_tax_id', 'required'],
      ['company_iban', 'recommended'],
      ['company_email', 'recommended'],
      ['company_federal_state', 'recommended'],
      ['email_unverified', 'recommended'],
    ])
    expect(notices[0]?.route).toBe('/einstellungen?bereich=company')
    expect(notices[5]?.route).toBe('/sicherheit')
    expect(
      companyNotices({
        company: { ...complete, vatId: 'DE123', taxNumber: null, city: null },
        canManageCompany: true,
        emailVerified: true,
      }).map((n) => n.key),
    ).toEqual(['company_address'])
    // Without the right to change the company only the own e-mail is shown.
    expect(
      companyNotices({ company: empty, canManageCompany: false, emailVerified: false }).map(
        (n) => n.key,
      ),
    ).toEqual(['email_unverified'])
  })

  it('reminds of a failing invoice mailbox and an expiring Microsoft 365 secret', () => {
    const base = { company: complete, canManageCompany: true, emailVerified: true }
    const mail = (failedRuns: number, secretExpiresOn: string | null, lastError: string | null) =>
      companyNotices({
        ...base,
        incomingMail: { failedRuns, lastError, secretExpiresOn, today: '2026-11-15' },
      })
    expect(mail(2, '2026-12-16', 'Server weg.')).toEqual([])
    expect(mail(3, null, 'Der Mailserver ist nicht erreichbar.')).toEqual([
      {
        key: 'incoming_mail_failing',
        severity: 'recommended',
        message:
          'Der Rechnungseingang per E-Mail schlägt seit 3 Abrufen fehl: Der Mailserver ist nicht erreichbar.',
        route: '/einstellungen?bereich=incomingMail',
      },
    ])
    expect(mail(4, null, null)[0]?.message).toBe(
      'Der Rechnungseingang per E-Mail schlägt seit 4 Abrufen fehl.',
    )
    expect(mail(0, '2026-12-15', null)[0]?.message).toBe(
      'Der geheime Clientschlüssel für Microsoft 365 läuft am 15.12.2026 ab – rechtzeitig einen neuen anlegen und eintragen.',
    )
    expect(mail(0, '2026-11-14', null)[0]?.message).toBe(
      'Der geheime Clientschlüssel für Microsoft 365 ist am 14.11.2026 abgelaufen – neuen Schlüssel in Microsoft Entra anlegen und eintragen.',
    )
  })
})
