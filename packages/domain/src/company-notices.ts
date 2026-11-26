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
  /**
   * Rechnungseingang per E-Mail, only for people who may change the settings and only while the
   * mailbox is fetched: failed runs in a row and the expiry date of the Microsoft 365 secret.
   */
  /** Pflichtangaben missing in the letterhead (people who may change it). */
  letterheadGaps?: readonly ('name' | 'address' | 'tax_id')[]
  /** Admins of the company without a second factor (people who manage users). */
  adminsWithoutSecondFactor?: number
  incomingMail?: {
    failedRuns: number
    lastError: string | null
    secretExpiresOn: string | null
    today: string
  }
}

/** Failed fetches in a row before the bar shows it (a single timeout is no reason to worry). */
export const INCOMING_MAIL_FAILURE_NOTICE = 3
/** Days before the Microsoft 365 client secret expires when the bar starts to remind. */
export const SECRET_EXPIRY_NOTICE_DAYS = 30

export type CompanyNoticeKey =
  | 'company_address'
  | 'company_tax_id'
  | 'company_iban'
  | 'company_email'
  | 'company_federal_state'
  | 'email_unverified'
  | 'incoming_mail_failing'
  | 'letterhead_gaps'
  | 'admins_without_mfa'
  | 'incoming_mail_secret_expiring'

export interface CompanyNotice {
  key: CompanyNoticeKey
  severity: 'required' | 'recommended'
  message: string
  /** Where to fix it (internal path of the web app). */
  route: string
}

const COMPANY = '/einstellungen?bereich=company'
const INCOMING_MAIL = '/einstellungen?bereich=incomingMail'

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

const germanDay = (iso: string) => iso.split('-').reverse().join('.')

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
  const gaps = input.letterheadGaps ?? []
  if (gaps.length) {
    const labels = {
      name: 'Firmenname',
      address: 'Anschrift',
      tax_id: 'Steuernummer oder USt-IdNr.',
    }
    notices.push({
      key: 'letterhead_gaps',
      severity: 'required',
      message: `Im Briefpapier fehlt: ${gaps.map((g) => labels[g]).join(', ')} – Pflichtangaben auf Rechnungen (§ 14 UStG).`,
      route: '/einstellungen?bereich=letterhead',
    })
  }
  if (input.adminsWithoutSecondFactor) {
    const one = input.adminsWithoutSecondFactor === 1
    notices.push({
      key: 'admins_without_mfa',
      severity: 'recommended',
      message: `${input.adminsWithoutSecondFactor} ${one ? 'Person' : 'Personen'} mit Administratorrechten ${one ? 'meldet' : 'melden'} sich ohne zweiten Faktor an.`,
      route: '/benutzer',
    })
  }
  const mail = input.incomingMail
  if (mail && mail.failedRuns >= INCOMING_MAIL_FAILURE_NOTICE) {
    notices.push({
      key: 'incoming_mail_failing',
      severity: 'recommended',
      message: `Der Rechnungseingang per E-Mail schlägt seit ${mail.failedRuns} Abrufen fehl${mail.lastError ? `: ${mail.lastError}` : '.'}`,
      route: INCOMING_MAIL,
    })
  }
  if (mail?.secretExpiresOn) {
    const days = daysBetween(mail.today, mail.secretExpiresOn)
    if (days <= SECRET_EXPIRY_NOTICE_DAYS) {
      notices.push({
        key: 'incoming_mail_secret_expiring',
        severity: 'recommended',
        message:
          days < 0
            ? `Der geheime Clientschlüssel für Microsoft 365 ist am ${germanDay(mail.secretExpiresOn)} abgelaufen – neuen Schlüssel in Microsoft Entra anlegen und eintragen.`
            : `Der geheime Clientschlüssel für Microsoft 365 läuft am ${germanDay(mail.secretExpiresOn)} ab – rechtzeitig einen neuen anlegen und eintragen.`,
        route: INCOMING_MAIL,
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
