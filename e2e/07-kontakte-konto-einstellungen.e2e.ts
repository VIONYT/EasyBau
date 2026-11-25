import { expect, test } from '@playwright/test'
import {
  type AdminSession,
  expectNoHorizontalScroll,
  SCREENSHOTS,
  SETUP_TOKEN,
  session,
} from './support'

test.describe.configure({ mode: 'serial' })

// Logged-in admin with the virtual security key (from 01-einrichtung, or restored from disk).
let page: AdminSession['page']
test.beforeAll(async ({ browser }) => {
  ;({ page } = await session(browser))
})

test('Kontakte: Kanäle, Rechnungsempfänger, Ansprechpartner, Filter und CSV-Import', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(90_000)
  await page.getByRole('button', { name: 'Kontakte' }).click()
  const create = page.locator('form.inline-form')
  const editor = page.locator('.contact-editor')

  // Neue Organisation mit E-Mail, Telefon und abweichendem Rechnungsempfänger
  await create.getByLabel('Name der Organisation').fill('Hausverwaltung Klee GmbH')
  await create.getByRole('button', { name: 'Speichern' }).click()
  await expect(editor.getByRole('heading', { name: /Hausverwaltung Klee GmbH/ })).toBeVisible()
  await editor.getByRole('button', { name: '+ E-Mail oder Telefon' }).click()
  await editor.getByLabel('Adresse / Nummer').fill('info@klee.example')
  await editor.getByLabel('Straße und Hausnummer').first().fill('Gartenstraße 9')
  await editor.getByLabel('PLZ').first().fill('30161')
  await editor.getByLabel('Ort').first().fill('Hannover')
  await editor.getByLabel('Abweichender Rechnungsempfänger').check()
  await editor
    .getByLabel('Empfängerblock (Name, Abteilung, z. Hd.)')
    .fill('Hausverwaltung Klee GmbH\nBuchhaltung')
  await editor.locator('.billing-address').getByLabel('Straße und Hausnummer').fill('Postfach 4711')
  await editor.locator('.billing-address').getByLabel('PLZ').fill('30001')
  await editor.locator('.billing-address').getByLabel('Ort').fill('Hannover')
  await editor.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Kontakt gespeichert.')).toBeVisible()
  await expect(editor.getByLabel('Adresse / Nummer')).toHaveValue('info@klee.example')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/kontakt.png`, fullPage: true })

  // Ansprechpartnerin anlegen und verknüpfen
  const organizationUrl = page.url()
  await editor.getByRole('button', { name: 'Schließen' }).click()
  await create.getByText('Person', { exact: true }).click()
  await create.getByLabel('Vorname').fill('Klara')
  await create.getByLabel('Nachname').fill('Klee')
  await create.getByRole('button', { name: 'Speichern' }).click()
  await expect(editor.getByRole('heading', { name: /Klee, Klara/ })).toBeVisible()
  await editor.getByRole('button', { name: '+ Organisation' }).click()
  await editor.getByLabel('Suchen', { exact: true }).fill('Klee')
  await editor
    .getByLabel('Organisation', { exact: true })
    .selectOption({ label: 'Hausverwaltung Klee GmbH' })
  await editor.getByLabel('Funktion').fill('Buchhaltung')
  await editor.getByRole('button', { name: 'Verknüpfen' }).click()
  await expect(editor.getByText('· Buchhaltung')).toBeVisible()
  expect(organizationUrl).toContain('/kontakte')

  // Filter: nur Personen
  await page.getByLabel('Art', { exact: true }).selectOption({ label: 'Person' })
  await expect(page.getByRole('button', { name: /Klee, Klara/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Wohnbau Nord eG/ })).toHaveCount(0)
  await page.getByLabel('Art', { exact: true }).selectOption({ label: 'Alle' })

  // CSV: Export-Link und Import mit Vorschau
  await expect(page.getByRole('link', { name: 'CSV exportieren' })).toHaveAttribute(
    'href',
    /\/api\/v1\/contacts\/export\.csv/,
  )
  await page.getByRole('button', { name: 'CSV importieren' }).click()
  await page.getByLabel('CSV-Datei').setInputFiles({
    name: 'kontakte.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Firma;Straße;PLZ;Ort;E-Mail\r\nDachdecker Wind KG;Am Deich 2;26122;Oldenburg;post@wind.example\r\nHausverwaltung Klee GmbH;Gartenstraße 9;30161;Hannover;\r\n',
    ),
  })
  await page.getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.getByText(/1 neu, 1 übersprungen, 0 fehlerhaft/)).toBeVisible()
  await page.getByRole('button', { name: '1 Kontakte importieren' }).click()
  await expect(page.getByText(/1 importiert/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Dachdecker Wind KG/ })).toBeVisible()
  await expectNoHorizontalScroll(page)
})

test('Konto: Passwort vergessen und Passwort-Link der Administration', async ({ browser }) => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')

  // Administration: Link für den Monteur erstellen (ohne SMTP nur zum Übergeben)
  await page.getByRole('button', { name: 'Benutzer' }).click()
  const row = page.locator('li', { hasText: 'Max Monteur' })
  await row.getByRole('button', { name: 'Passwort-Link' }).click()
  await expect(page.getByRole('heading', { name: 'Neues Passwort für Max Monteur' })).toBeVisible()
  const link = (await page.locator('code.secret').textContent()) ?? ''
  expect(link).toMatch(/\/passwort-zuruecksetzen#[A-Za-z0-9_-]{43}$/)
  await expectNoHorizontalScroll(page)

  // Der Monteur setzt in einem eigenen Browser ein neues Passwort und meldet sich an.
  const other = await browser.newContext({ ignoreHTTPSErrors: true })
  const monteur = await other.newPage()
  await monteur.goto(new URL(link).pathname + new URL(link).hash)
  await expect(monteur.getByRole('heading', { name: 'Neues Passwort festlegen' })).toBeVisible()
  await expect(monteur.getByText('monteur@example.test')).toBeVisible()
  await monteur.locator('input[name=password]').fill('neues-monteur-passwort')
  await monteur.locator('input[name=repeat]').fill('anderes-passwort-123')
  await monteur.getByRole('button', { name: 'Passwort speichern' }).click()
  await expect(
    monteur.getByText('Die beiden Passwörter stimmen nicht überein.').first(),
  ).toBeVisible()
  await monteur.locator('input[name=repeat]').fill('neues-monteur-passwort')
  await monteur.getByRole('button', { name: 'Passwort speichern' }).click()
  await expect(monteur.getByText('Das neue Passwort ist gespeichert.')).toBeVisible()
  await expect(monteur).toHaveURL(/\/$/)
  await monteur.getByRole('button', { name: 'Anmelden' }).click()
  await monteur.getByLabel('E-Mail-Adresse').fill('monteur@example.test')
  await monteur.locator('input[name=password]').fill('neues-monteur-passwort')
  await monteur.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(monteur.getByRole('heading', { name: 'Übersicht' })).toBeVisible()

  // Der Link gilt nur einmal.
  await monteur.goto(new URL(link).pathname + new URL(link).hash)
  await expect(
    monteur.getByText('Der Link ist ungültig oder abgelaufen.', { exact: false }),
  ).toBeVisible()

  // „Passwort vergessen?“ ohne SMTP: Hinweis auf die Administration (gleich für jede Adresse)
  await monteur.goto('/')
  await monteur.getByRole('button', { name: 'Abmelden' }).click()
  await monteur.getByRole('button', { name: 'Passwort vergessen?' }).click()
  await monteur.getByLabel('E-Mail-Adresse').fill('monteur@example.test')
  await monteur.getByRole('button', { name: 'Link anfordern' }).click()
  await expect(monteur.getByText(/kein E-Mail-Versand eingerichtet/)).toBeVisible()
  await expectNoHorizontalScroll(monteur)
  await other.close()

  // Sicherheit: Status der E-Mail-Adresse
  await page.getByRole('button', { name: 'Sicherheit' }).click()
  await expect(page.getByRole('heading', { name: 'E-Mail-Adresse' })).toBeVisible()
  await expect(page.getByText('nicht bestätigt')).toBeVisible()
})

test('Einstellungen: Hinweisleiste, Feiertage, Lohnkostenanteil, Dateinamen und Anhänge', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  // Hinweisleiste: only the federal state is still missing; „Beheben“ opens the company settings
  await page.getByRole('button', { name: 'Projekte' }).click()
  const notices = page.getByRole('region', { name: 'Hinweise' })
  await expect(notices).toContainText('Bundesland fehlt')
  await expectNoHorizontalScroll(page)
  await notices.getByRole('link', { name: 'Beheben' }).click()
  await expect(page.locator('#settings-section')).toHaveValue('company')
  await page.getByLabel('Bundesland').selectOption({ label: 'Niedersachsen' })
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()
  await page.getByRole('button', { name: 'Projekte' }).click()
  await expect(page.getByRole('region', { name: 'Hinweise' })).toHaveCount(0)

  // Feiertage: computed for Niedersachsen, plus an own day
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.locator('#settings-section').selectOption({ label: 'Feiertage' })
  await expect(
    page.getByRole('heading', { name: 'Gesetzliche Feiertage in Niedersachsen' }),
  ).toBeVisible()
  const days = page.getByRole('listitem')
  await expect(days.filter({ hasText: 'Reformationstag' })).toBeVisible()
  // Not statutory in Niedersachsen (the hint text mentions it as a local holiday elsewhere)
  await expect(days.filter({ hasText: 'Fronleichnam' })).toHaveCount(0)
  await page.getByLabel('Datum').fill(`${new Date().getFullYear()}-12-24`)
  await page.getByLabel('Bezeichnung').fill('Betriebsruhe')
  await page.getByRole('button', { name: 'Eigenen Tag hinzufügen' }).click()
  await expect(page.getByText(/Betriebsruhe · eigener Eintrag/)).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Dokumente: § 35a also for organizations, file names, AGB as automatic attachment of quotes
  await page.locator('#settings-section').selectOption({ label: 'Dokumente' })
  await expect(
    page.getByRole('heading', { name: 'Lohnkostenanteil ausweisen (§ 35a EStG)' }),
  ).toBeVisible()
  await page
    .getByRole('group', { name: 'Rechnungen', exact: true })
    .getByLabel('an Organisationen')
    .check()
  await page.getByLabel('Muster für PDF-Dateien und E-Mail-Anhänge').fill('{Typ}_{Nummer}_{Kunde}')
  await page.getByLabel('Bezeichnung (wird Dateiname)').fill('AGB Muster Bau')
  await page.getByLabel('PDF hochladen').setInputFiles({
    name: 'agb.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
  })
  await expect(page.getByText('AGB Muster Bau.pdf')).toBeVisible()
  await page
    .getByRole('group', { name: 'Anhängen an' })
    .getByLabel('Angebot', { exact: true })
    .check()
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()
  await expect(page.getByText('Beispiel: Rechnung_R2026-00101_Mustermann,_Max.pdf')).toBeVisible()
  await expectNoHorizontalScroll(page)
  // back to the default, so later steps see the usual file names
  await page.getByRole('button', { name: 'Standard' }).click()
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Beispiel: Rechnung_R2026-00101.pdf')).toBeVisible()
})
