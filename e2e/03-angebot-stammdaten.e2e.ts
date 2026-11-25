import { expect, test } from '@playwright/test'
import {
  type AdminSession,
  datanormFile,
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

test('Angebot: Kalkulation, Fertigstellen, Druckansicht und Nachtrag-Schalter', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  // Kunde anlegen
  await page.getByRole('button', { name: 'Kontakte' }).click()
  await page.getByLabel('Name der Organisation').fill('Wohnbau Nord eG')
  await page.getByRole('button', { name: 'Speichern' }).click()
  // The new contact opens in the editor (address, e-invoice data) and appears in the list.
  await expect(page.getByRole('heading', { name: /^Wohnbau Nord eG · K-/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Wohnbau Nord eG/ })).toBeVisible()

  // Angebot öffnen
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Dokumente' }).click()
  await page.getByRole('link', { name: /^Angebot/ }).click()
  await expect(page.getByRole('heading', { name: 'Angebot', exact: true })).toBeVisible()

  // Nachtrag-Schalter: ohne Hauptauftrag nicht möglich
  await expect(page.getByRole('switch', { name: 'Nachtragsangebot' })).toBeDisabled()

  // Kalkulation: 18 min Lohn à 54 €/Std + 0,3 l Farbe à 8 € → EP 18,60 €
  await page.getByRole('button', { name: 'Kalkulation: Wandfläche streichen' }).click()
  await page.getByLabel('Menge', { exact: true }).first().fill('18')
  await page.getByLabel('Stundensatz (€/Std)').fill('54')
  await page.getByRole('button', { name: '+ Kostenzeile' }).click()
  await page.getByLabel('Art').nth(1).selectOption({ label: 'Material' })
  await page.getByLabel('Menge', { exact: true }).nth(1).fill('0,3')
  await page.getByLabel('Einheit', { exact: true }).nth(1).selectOption({ label: 'l' })
  await page.getByLabel('Kosten je Einheit (€)').fill('8')
  await page.getByRole('button', { name: 'Speichern', exact: true }).last().click()
  await expect(page.locator('.position--item .calc')).toContainText('36,44 m² × 18,60')
  await expect(page.locator('.position--item .amount')).toHaveText('677,78\u00a0€')
  await expect(page.locator('.calc-tag')).toContainText('Kalkulation')

  // Empfänger wählen und fertigstellen
  await page.getByLabel('Empfänger').selectOption({ label: 'Wohnbau Nord eG' })
  await page.getByRole('button', { name: 'Speichern', exact: true }).first().click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Fertigstellen' }).click()
  await expect(page.getByText(/^A-00101/)).toBeVisible()
  await expect(page.getByText('Fertiggestellt', { exact: true })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Druckansicht
  await page.getByRole('link', { name: 'Vorschau / Drucken' }).click()
  await expect(page.getByRole('heading', { name: 'Angebot A-00101' })).toBeVisible()
  await expect(page.locator('.letter-recipient')).toContainText('Wohnbau Nord eG')
  await expect(page.locator('.letter-totals .grand dd')).toHaveText('806,56\u00a0€')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/angebot-druck.png`, fullPage: true })
  await page.getByRole('link', { name: /Zurück zum Dokument/ }).click()
  await page.getByRole('button', { name: 'Beauftragt' }).click()
  await expect(page.getByText('Beauftragt', { exact: true }).first()).toBeVisible()

  // Hauptauftrag aus dem Angebot, fertigstellen
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Neues Dokument' }).click()
  await page.getByRole('radio', { name: 'Auftragsbestätigung', exact: true }).check()
  await page.getByLabel('Positionen übernehmen aus').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Dokument erstellen' }).click()
  await expect(page.getByRole('heading', { name: 'Auftragsbestätigung' })).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Fertigstellen' }).click()
  await expect(page.getByText(/^AB-00101/)).toBeVisible()

  // Neues Angebot → per Schalter zum Nachtragsangebot
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Neues Dokument' }).click()
  await page.getByRole('button', { name: 'Dokument erstellen' }).click()
  await expect(page.getByRole('heading', { name: 'Angebot', exact: true })).toBeVisible()
  await page.getByRole('switch', { name: 'Nachtragsangebot' }).check()
  await page.getByLabel('Begründung').fill('Zusätzliche Fensterlaibungen')
  await page.getByRole('button', { name: 'Umschalten' }).click()
  await expect(page.getByRole('heading', { name: 'Nachtragsangebot N01' })).toBeVisible()
  await expect(page.getByText(/Nachtrag zum Hauptauftrag AB-00101/)).toBeVisible()
  await page.getByRole('button', { name: '+ Position' }).click()
  await page.getByLabel('Kurztext').fill('Fensterlaibung putzen')
  await page.getByLabel('Menge').fill('4')
  await page.getByLabel('Einheit', { exact: true }).selectOption({ label: 'Stk. – Stück' })
  await page.getByLabel('Einheitspreis netto (€)').fill('45')
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  await expect(page.locator('.position--item .oz')).toHaveText('N01.1')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/nachtrag.png`, fullPage: true })
  // Schalter zurück: wieder ein normales Angebot
  await page.getByRole('switch', { name: 'Nachtragsangebot' }).click()
  await expect(page.getByRole('heading', { name: 'Angebot', exact: true })).toBeVisible()
  await expect(page.locator('.position--item .oz')).toHaveText('1')
})

test('Stammdaten, DATANORM-Katalog und Einfügen ins Angebot', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  // Leistung mit Kalkulation
  await page.getByRole('button', { name: 'Stammdaten', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Leistungen' })).toBeVisible()
  await page.getByRole('button', { name: 'Neue Leistung' }).click()
  await page.getByLabel('Kurztext').fill('Fensterlaibung putzen')
  await page.getByRole('button', { name: '+ Kostenzeile' }).click()
  await page.getByLabel('Menge', { exact: true }).fill('20')
  await page.getByLabel('Stundensatz (€/Std)').fill('54')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText(/VK 18,00\s€ je m²/)).toBeVisible()

  // DATANORM-Katalog importieren
  await page.getByRole('button', { name: 'Kataloge' }).click()
  await page.getByLabel('Name des Katalogs').fill('Baustoff Nord')
  await page.locator('input[type=file]').setInputFiles({
    name: 'NORD2027.001',
    mimeType: 'application/octet-stream',
    buffer: datanormFile(),
  })
  await expect(page.getByText(/Importiert: 3 Artikel/)).toBeVisible()
  await expect(page.getByText(/Einheiten ohne Zuordnung.*Fass/)).toBeVisible()
  await page.getByLabel('In Katalogen suchen (Text, Artikelnummer, EAN)').fill('Dispersionsfarbe')
  await expect(page.getByText('Hochdeckende Innenfarbe')).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/kataloge.png`, fullPage: true })
  await page.getByRole('button', { name: 'In Stammdaten übernehmen' }).click()
  await expect(page.getByText(/In die Materialien übernommen/)).toBeVisible()
  await page.getByRole('button', { name: 'Materialien' }).click()
  await expect(page.getByText('Dispersionsfarbe weiß 12,5 l')).toBeVisible()
  await expect(page.getByText('aus Katalog')).toBeVisible()

  // Ins Angebot einfügen: Leistung aus Stammdaten und Artikel direkt aus dem Katalog
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Dokumente' }).click()
  await page
    .getByRole('link', { name: /^Angebot/ })
    .last()
    .click()
  await page.getByRole('button', { name: '+ Aus Stammdaten' }).click()
  await page.getByLabel('Leistung, Material oder Katalogartikel suchen').fill('Fensterlaibung')
  await page.getByLabel('Menge', { exact: true }).fill('4')
  await page.getByRole('button', { name: 'Einfügen: Fensterlaibung putzen' }).click()
  await expect(
    page
      .locator('.position--item')
      .filter({ hasText: 'Fensterlaibung putzen' })
      .locator('.calc-tag'),
  ).toBeVisible()
  await page.getByRole('button', { name: '+ Aus Stammdaten' }).click()
  await page.getByLabel('Leistung, Material oder Katalogartikel suchen').fill('Spax')
  await page.getByLabel('Menge', { exact: true }).fill('100')
  await page.getByRole('button', { name: 'Einfügen: Spax Schraube 4x40' }).click()
  await expect(
    page.locator('.position--item').filter({ hasText: 'Spax Schraube 4x40' }),
  ).toContainText('100 Stk.')
  await expectNoHorizontalScroll(page)
})
