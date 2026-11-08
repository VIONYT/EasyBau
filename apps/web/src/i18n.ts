/**
 * UI texts (CLAUDE.md: never hard-coded in components). de-DE is the base language;
 * further languages add a dictionary with the same keys.
 */
const de = {
  'app.tagline': 'Betriebssoftware für Bau- und Handwerksbetriebe',
  'common.save': 'Speichern',
  'common.cancel': 'Abbrechen',
  'common.loading': 'Wird geladen …',
  'common.required': 'Pflichtfeld',
  'common.search': 'Suchen',
  'common.empty': 'Noch keine Einträge.',
  'common.networkError': 'Der Server ist nicht erreichbar. Bitte Verbindung prüfen.',
  'setup.title': 'Ersteinrichtung',
  'setup.intro': 'Legen Sie Ihre Firma und das erste Administrator-Konto an.',
  'setup.token': 'Einrichtungscode',
  'setup.tokenHint': 'Steht im Server-Log: docker compose logs app',
  'setup.company': 'Firma',
  'setup.companyName': 'Firmenname mit Rechtsform',
  'setup.trade': 'Gewerk',
  'setup.street': 'Straße und Hausnummer',
  'setup.postalCode': 'PLZ',
  'setup.city': 'Ort',
  'setup.admin': 'Ihr Zugang',
  'setup.displayName': 'Ihr Name',
  'setup.submit': 'Einrichtung abschließen',
  'auth.title': 'Anmelden',
  'auth.email': 'E-Mail-Adresse',
  'auth.password': 'Passwort',
  'auth.passwordHint': 'Mindestens 12 Zeichen',
  'auth.totp': 'Code aus der Authenticator-App',
  'auth.submit': 'Anmelden',
  'auth.logout': 'Abmelden',
  'auth.twoFactorRequired':
    'Bitte richten Sie die Zwei-Faktor-Anmeldung ein. Für Admins ist sie vorgeschrieben.',
  'nav.projects': 'Projekte',
  'nav.contacts': 'Kontakte',
  'contacts.new': 'Neuer Kontakt',
  'contacts.kind': 'Art des Kontakts',
  'contacts.kind.organization': 'Organisation',
  'contacts.kind.person': 'Person',
  'contacts.organizationName': 'Name der Organisation',
  'contacts.firstName': 'Vorname',
  'contacts.lastName': 'Nachname',
  'contacts.number': 'Nummer',
  'projects.new': 'Neues Projekt',
  'projects.name': 'Projektname',
  'projects.customer': 'Kunde',
  'projects.noCustomer': 'Kein Kunde',
  'projects.city': 'Ort der Baustelle',
} as const

export type TextKey = keyof typeof de

export function t(key: TextKey): string {
  return de[key]
}
