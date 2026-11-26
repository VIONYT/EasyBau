import { expect, test } from '@playwright/test'
import {
  createCustomer,
  createDiaryReport,
  createOrderConfirmation,
  createProject,
} from './fixtures'
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
// Own data (C.11): customer, project with a finalized Auftragsbestätigung (with labour, so the
// project has Soll-Stunden) and a Bautagesbericht with a Vorkommnis.
const CUSTOMER = 'Hausverwaltung Birkenallee GmbH'
const PROJECT = 'Kellerabdichtung Birkenallee'
let projectNumber = ''
let ab = { id: '', number: '' }
test.beforeAll(async ({ browser }) => {
  ;({ page } = await session(browser))
  if (!SETUP_TOKEN) return
  const customerId = await createCustomer(page, CUSTOMER)
  const project = await createProject(page, PROJECT, customerId)
  projectNumber = project.number
  ab = await createOrderConfirmation(page, project.id, customerId, [
    { shortText: 'Kellerwand abdichten', quantity: '42', unitPriceCents: 8900, laborMinutes: 45 },
    { shortText: 'Drainage verlegen', quantity: '18', unitPriceCents: 6400 },
  ])
  await createDiaryReport(
    page,
    project.id,
    '2026-11-09',
    'Wasserleitung undicht, Arbeiten 1 h unterbrochen.',
  )
})

test('E-Mail-Vorlagen und Versand am Dokument', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.locator('#settings-section').selectOption({ label: 'E-Mail-Vorlagen' })
  await expect(page.getByRole('heading', { name: 'E-Mail-Vorlagen' })).toBeVisible()
  await expect(page.getByLabel('Betreff')).toHaveValue('{Dokument} {Nummer} – {Firma}')
  await page.getByLabel('Betreff').fill('Ihre {Dokument} {Nummer}')
  await page
    .getByLabel('Blindkopie jeder Dokument-E-Mail an (z. B. Büro-Postfach)')
    .fill('buero@muster-bau.example')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()
  await expect(page.getByLabel('Dokumentart')).toContainText('Rechnung (eigene Vorlage)')
  await expectNoHorizontalScroll(page)

  // At the finalized Auftragsbestätigung: the panel explains that SMTP is not set up in this stack
  await page.goto(`/dokumente/${ab.id}`)
  await expect(page.getByRole('heading', { name: 'Per E-Mail senden' })).toBeVisible()
  await expect(page.getByText(/E-Mail-Versand ist nicht eingerichtet/)).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Mahnvorschläge: the filter answers (whether something is due depends on the other files)
  await page.getByRole('button', { name: 'Rechnungen', exact: true }).click()
  const due = page.getByLabel('Mahnung fällig (Mahnvorschläge)')
  await due.check()
  await expect(due).toBeChecked()
  await expectNoHorizontalScroll(page)
})

test('Regiebericht in die Rechnung, Nachtrag aus dem Bautagebuch, Vertragssumme', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  // Regiebericht: Stunden, Leistungszeitraum, Unterschrift von Auftragnehmer und Auftraggeber
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: PROJECT }).click()
  await page.getByRole('button', { name: 'Berichte', exact: true }).click()
  await page.getByRole('button', { name: 'Neuer Bericht' }).click()
  await page.getByLabel('Art des Berichts').selectOption({ label: 'Regiebericht' })
  await page.getByLabel('Datum').fill('2026-11-10')
  await page.getByRole('button', { name: 'Bericht anlegen' }).click()
  await expect(page.getByRole('heading', { name: /Regiebericht – 10\.11\.2026/ })).toBeVisible()
  await page.getByLabel('Leistungszeitraum von').fill('2026-11-10')
  await page.getByLabel('Leistungszeitraum bis').fill('2026-11-10')
  await page.getByLabel('Stunden', { exact: true }).first().fill('6')
  await page.getByLabel('Tätigkeit').first().fill('Rohrbruch freigelegt')
  await page.getByRole('button', { name: 'Bericht speichern' }).click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()
  await page.getByLabel('Name Auftraggeber').fill('Frau Berger')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Unterschreiben und abschließen' }).click()
  await expect(page.getByText('Dieser Bericht ist unterschrieben und gesperrt.')).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('link', { name: PROJECT }).click()
  await expect(page.getByText('noch nicht abgerechnet')).toBeVisible()

  // Rechnung: Bericht übernehmen → Titel mit Stunden je Lohngruppe
  await page.getByRole('button', { name: 'Dokumente' }).click()
  await page.getByRole('button', { name: 'Neues Dokument' }).click()
  await page.getByRole('radio', { name: 'Rechnung', exact: true }).check()
  await page.getByRole('button', { name: 'Dokument erstellen' }).click()
  await expect(page.getByRole('heading', { name: 'Rechnung', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Berichte übernehmen' }).click()
  await page.getByLabel(/Regiebericht · 10\.11\.2026/).check()
  await page.getByRole('button', { name: 'Ausgewählte übernehmen' }).click()
  await expect(page.getByText('Regiebericht vom 10.11.2026').first()).toBeVisible()
  await expect(page.getByText(/Stundenlohnarbeiten/).first()).toBeVisible()
  await expectNoHorizontalScroll(page)
  // Draft removed again (later tests open the last invoice of the project); the report is free again.
  const draftId = page.url().split('/').pop() as string
  expect((await page.request.delete(`/api/v1/documents/${draftId}`)).status()).toBe(204)

  // Nachtrag aus „Besondere Vorkommnisse“ des Bautagebuchs, der Bericht ist Nachweis
  await page.getByRole('link', { name: PROJECT }).click()
  await page.getByRole('button', { name: 'Bautagebuch' }).click()
  await page.getByText(/Mo\.?, 09\.11\.2026/).click()
  await page.getByRole('button', { name: 'Nachtrag anlegen' }).click()
  await expect(page.getByRole('heading', { name: 'Nachweise' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Bautagesbericht vom 09.11.2026' })).toBeVisible()
  await expect(page.getByText(/Wasserleitung undicht/).first()).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Projektübersicht: Vertragssumme mit dem Nachtrag (Entwurf zählt nicht)
  await page.getByRole('link', { name: PROJECT }).click()
  await page.locator('nav.tabs.sub').getByRole('button', { name: 'Übersicht' }).click()
  const contract = page.locator('section.contract')
  await expect(contract.getByRole('heading', { name: 'Vertragssumme' })).toBeVisible()
  await expect(contract.getByText('Hauptauftrag', { exact: true })).toBeVisible()
  await expect(contract.getByText(/N0\d/).first()).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/vertragssumme.png`, fullPage: true })
})

test('Projektkennzahlen und Filter der Projektliste', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')

  // Kennzahlen in der Projektübersicht
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: PROJECT }).click()
  const figures = page.locator('section.figures')
  await expect(figures.getByRole('heading', { name: 'Kennzahlen' })).toBeVisible()
  await expect(figures.getByRole('heading', { name: 'Soll-Stunden' })).toBeVisible()
  await expect(figures.getByText(`aus der Kalkulation von ${ab.number}`)).toBeVisible()
  await expect(figures.getByRole('heading', { name: 'Auftragssumme' })).toBeVisible()
  await expect(figures.getByRole('heading', { name: 'Abgerechnet' })).toBeVisible()
  await expect(figures.getByRole('heading', { name: 'Offene Forderungen' })).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/kennzahlen.png`, fullPage: true })

  // Filter: Zeitraum und Mitarbeitende
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByText('Filter', { exact: true }).click()
  await page.getByLabel('Mitarbeitende').selectOption({ label: 'Nur meine Projekte' })
  await page.getByLabel('Zeitraum von').fill('2020-01-01')
  await page.getByLabel('Zeitraum bis').fill('2020-12-31')
  await expect(page.getByText('Noch keine Einträge.')).toBeVisible()
  await page.getByLabel('Zeitraum bis').fill('2030-12-31')
  await expect(page.getByRole('link', { name: PROJECT })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Filter zurücksetzen' }).click()
  await expect(page.getByLabel('Zeitraum von')).toHaveValue('')
})

test('Übersicht, globale Suche und Benachrichtigungen', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')

  await page.getByRole('button', { name: 'Übersicht', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Offene Forderungen' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Heute auf der Baustelle' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Offene Angebote und Nachträge' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Zuletzt bearbeitete Projekte' })).toBeVisible()
  // Beträge ausblenden (vor Kunden)
  await page.getByLabel('Beträge ausblenden').check()
  await expect(page.locator('.dashboard .amount-hero').first()).toHaveText('•••')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/uebersicht.png`, fullPage: true })
  await page.getByLabel('Beträge ausblenden').uncheck()

  // Globale Suche über Projekte, Kontakte, Dokumente
  await page.getByRole('searchbox', { name: 'Suchen' }).fill('Birkenallee')
  await page.getByRole('searchbox', { name: 'Suchen' }).press('Enter')
  await expect(page.getByRole('heading', { name: 'Suche: „Birkenallee“' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Kontakte' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dokumente' })).toBeVisible()
  await expectNoHorizontalScroll(page)
  // A contact hit opens the contact itself (own URL).
  await page.getByRole('region', { name: 'Kontakte' }).getByRole('link', { name: CUSTOMER }).click()
  await expect(page).toHaveURL(/\/kontakte\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: CUSTOMER })).toBeVisible()
  // The contacts page has its own search field; use the one in the top bar.
  const topSearch = page.getByRole('search').getByRole('searchbox', { name: 'Suchen' })
  await topSearch.fill('Kellerabdichtung')
  await topSearch.press('Enter')
  await page
    .getByRole('region', { name: 'Projekte' })
    .getByRole('link', { name: `${projectNumber} · ${PROJECT}` })
    .click()
  await expect(page.getByRole('heading', { name: PROJECT, level: 1 })).toBeVisible()

  // Benachrichtigungen
  await page.getByRole('button', { name: /^Benachrichtigungen/ }).click()
  await expect(page.getByRole('heading', { name: 'Benachrichtigungen', level: 1 })).toBeVisible()
  await expectNoHorizontalScroll(page)
})
