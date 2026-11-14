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
})
