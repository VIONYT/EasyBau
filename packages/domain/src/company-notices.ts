/**
 * Hinweisleiste (P2.11, DESIGN.md §7.4): missing company data shown as a yellow bar with a
 * direct link, before it blocks finalizing an invoice. `required` = Pflichtangabe nach
 * § 14 Abs. 4 UStG (finalizing fails without it), `recommended` = needed for a feature.
 */

export interface CompanyNoticeInput {
  company: {
    name: string
    street: string | null
    postalCode: string | null
    city: string | null
    taxNumber: string | null
    vatId: string | null
    iban: string | null
    email: string | null
    federalState: string | null
  }
  /** The person may change the company data (Einstellungen › Firma). */
  canManageCompany: boolean
  /** Own login address confirmed; null when it cannot be confirmed (no SMTP). */
  emailVerified: boolean | null
}

export type CompanyNoticeKey =
  | 'company_address'
  | 'company_tax_id'
  | 'company_iban'
  | 'company_email'
  | 'company_federal_state'
  | 'email_unverified'

export interface CompanyNotice {
  key: CompanyNoticeKey
  severity: 'required' | 'recommended'
  message: string
  /** Where to fix it (internal path of the web app). */
  route: string
}

const COMPANY = '/einstellungen?bereich=company'

export function companyNotices(input: CompanyNoticeInput): CompanyNotice[] {
  const notices: CompanyNotice[] = []
  const c = input.company
  if (input.canManageCompany) {
    if (!c.name.trim() || !c.street || !c.postalCode || !c.city) {
      notices.push({
        key: 'company_address',
        severity: 'required',
        message: 'Name und vollständige Anschrift der Firma fehlen – Pflichtangabe auf Rechnungen.',
        route: COMPANY,
      })
    }
    if (!c.taxNumber && !c.vatId) {
      notices.push({
        key: 'company_tax_id',
        severity: 'required',
        message: 'Steuernummer oder USt-IdNr. fehlt – Pflichtangabe auf Rechnungen (§ 14 UStG).',
        route: COMPANY,
      })
    }
    if (!c.iban) {
      notices.push({
        key: 'company_iban',
        severity: 'recommended',
        message:
          'Bankverbindung fehlt – ohne IBAN stehen keine Zahlungsangaben und kein Bezahlcode auf Rechnungen.',
        route: COMPANY,
      })
    }
    if (!c.email) {
      notices.push({
        key: 'company_email',
        severity: 'recommended',
        message:
          'E-Mail-Adresse der Firma fehlt – sie wird als Kontakt in der E-Rechnung angegeben.',
        route: COMPANY,
      })
    }
    if (!c.federalState) {
      notices.push({
        key: 'company_federal_state',
        severity: 'recommended',
        message: 'Bundesland fehlt – es bestimmt die gesetzlichen Feiertage.',
        route: COMPANY,
      })
    }
  }
  if (input.emailVerified === false) {
    notices.push({
      key: 'email_unverified',
      severity: 'recommended',
      message: 'Ihre E-Mail-Adresse ist noch nicht bestätigt.',
      route: '/sicherheit',
    })
  }
  return notices
}
