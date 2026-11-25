import { expect, test } from '@playwright/test'
import {
  ADMIN,
  type AdminSession,
  drawSignature,
  expectNoHorizontalScroll,
  PNG,
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

test('project with quote and filing (Ablage)', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(90_000)

  // Projekt anlegen
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('button', { name: 'Neues Projekt' }).click()
  await page.getByLabel('Projektname').fill('Sanierung Lindenweg')
  await page.getByLabel('Straße und Hausnummer').fill('Lindenweg 4')
  await page.getByLabel('PLZ').fill('30159')
  await page.getByLabel('Ort', { exact: true }).fill('Hannover')
  await page.getByLabel('Beginn').fill('2026-11-02')
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Projekt anlegen' }).click()
  await expect(page.getByRole('heading', { name: /Sanierung Lindenweg/ })).toBeVisible()
  await expect(page.getByText('Lindenweg 4, 30159 Hannover')).toBeVisible()
  await expect(page).toHaveURL(/\/projekte\/[0-9a-f-]{36}$/)

  // Angebot mit Titel und Position
  await page.getByRole('button', { name: 'Dokumente' }).click()
  await page.getByRole('button', { name: 'Neues Dokument' }).click()
  await expect(page.getByRole('radio', { name: 'Angebot', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: /Nachtragsangebot/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Dokument erstellen' }).click()
  await expect(page.getByRole('heading', { name: 'Angebot', exact: true })).toBeVisible()
  await expect(page.getByText('Entwurf (noch ohne Nummer)')).toBeVisible()

  await page.getByRole('button', { name: '+ Titel' }).click()
  await page.getByRole('textbox', { name: 'Titel', exact: true }).fill('Malerarbeiten')
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  await expect(page.getByText('1 Malerarbeiten')).toBeVisible()

  await page.getByRole('button', { name: '+ Position' }).click()
  await page.getByLabel('Kurztext').fill('Wandfläche streichen')
  await page.getByLabel('Menge').fill('12,5')
  await page.getByLabel('Einheit', { exact: true }).selectOption({ label: 'm² – Quadratmeter' })
  await page.getByLabel('Einheitspreis netto (€)').fill('45,00')
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  await expect(page.getByText('Wandfläche streichen')).toBeVisible()
  await expect(page.locator('.position--item .amount')).toHaveText('562,50\u00a0€')
  await expect(page.locator('.totals .grand dd')).toHaveText('669,38\u00a0€')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/angebot.png`, fullPage: true })

  // Back to the project: the quote is listed.
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await expect(page.getByRole('heading', { name: 'Angebote' })).toBeVisible()
  await expect(page.getByText('562,50\u00a0€')).toBeVisible()

  // Ablage: upload a photo into "Fotos"; disguised files are rejected.
  await page.getByRole('button', { name: 'Ablage' }).click()
  await page.getByRole('button', { name: /^Fotos/ }).click()
  await page
    .locator('input[type=file][multiple]')
    .setInputFiles({ name: 'Fassade Süd.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByText('Fassade Süd.png', { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Fassade Süd.png' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Fotos/ })).toContainText('1')
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'rechnung.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<html>'),
  })
  await expect(
    page.getByText(/rechnung\.pdf: Nicht hochgeladen – Dieser Dateityp ist nicht erlaubt/),
  ).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/ablage.png`, fullPage: true })

  // Direct link to the filing works after a reload (real URLs).
  await page.reload()
  await expect(page.getByText('Fassade Süd.png', { exact: true })).toBeVisible()
})

test('measurement sheet (Aufmaß) with rooms, formulas and quantity takeover', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(90_000)

  await page.getByRole('button', { name: 'Aufmaß' }).click()
  await page.getByRole('button', { name: 'Neues Aufmaßblatt' }).click()
  await expect(page.getByRole('radio', { name: /Angebotsaufmaß/ })).toBeChecked()
  await page.getByRole('button', { name: 'Aufmaßblatt anlegen' }).click()
  await expect(page.getByRole('heading', { name: 'Angebotsaufmaß 1' })).toBeVisible()
  await expect(page).toHaveURL(/\/aufmass\/[0-9a-f-]{36}$/)

  // Raum mit Maßen
  await page.getByRole('button', { name: '+ Raum hinzufügen' }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Bad')
  await page.getByLabel('Länge L (m)').fill('4,25')
  await page.getByLabel('Breite B (m)').fill('3,1')
  await page.getByLabel('Höhe H (m)').fill('2,6')
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  await expect(page.getByText('L 4,25 · B 3,1 · H 2,6')).toBeVisible()

  // Zeile aus Vorlage, live gerechnet, der LV-Position zugeordnet
  await page.getByRole('button', { name: '+ Zeile erfassen' }).click()
  await page.getByLabel('Raum', { exact: true }).selectOption({ label: 'Bad' })
  await page.getByLabel('LV-Position').selectOption({ label: '1.1 Wandfläche streichen [m²]' })
  await page.getByLabel('Beschreibung').fill('Wände')
  await page.getByRole('button', { name: 'Wandfläche (Raumumfang × Höhe)' }).click()
  await expect(page.getByLabel(/Formel oder Zahl/)).toHaveValue('2*(L+B)*H')
  await expect(page.getByText('Ergebnis: 38,22 m²')).toBeVisible()
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  await expect(page.locator('.m-line .result').first()).toHaveText('38,22 m²')

  // Abzug Tür (Raum und Position bleiben vom letzten Eintrag ausgewählt)
  await page.getByRole('button', { name: '+ Zeile erfassen' }).click()
  await page.getByLabel('Beschreibung').fill('Tür')
  await page.getByLabel(/Formel oder Zahl/).fill('0,885*2,01')
  await page.getByLabel('Abzug (z. B. Tür, Fenster)').check()
  await expect(page.getByText('Ergebnis: −1,78 m²')).toBeVisible()
  await page.getByLabel(/Formel oder Zahl/).fill('0,885*')
  await expect(page.getByText(/Ergebnis:/)).toHaveCount(0)
  await page.getByLabel(/Formel oder Zahl/).fill('0,885*2,01')
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  await expect(page.locator('.m-line .result').nth(1)).toHaveText('-1,78 m²')

  // Mengen je Position mit Hinweis auf Mehrmenge, Übernahme ins Angebot
  await expect(page.locator('.q-facts').first()).toContainText('36,44')
  await expect(page.getByText(/Mehrmenge .* Preisanpassung prüfen/)).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/aufmass.png`, fullPage: true })
  await page.getByRole('button', { name: /Mengen übernehmen in Angebot/ }).click()
  await expect(page.getByText(/Mengen übernommen/)).toBeVisible()

  // Gemeinsames Aufmaß: danach gesperrt
  await page.getByText('Gemeinsames Aufmaß abschließen', { exact: true }).first().click()
  await page.getByLabel('Für den Auftraggeber').fill('Frau Müller')
  // Handwritten signatures (pen/finger/mouse); the own one is kept in the account.
  await drawSignature(page, 'Unterschrift Auftragnehmer')
  await drawSignature(page, 'Unterschrift Auftraggeber')
  await expect(page.getByLabel('Für künftige Dokumente in meinem Konto speichern')).toBeChecked()
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/unterschrift.png`, fullPage: true })
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Gemeinsames Aufmaß abschließen' }).click()
  await expect(page.getByText(/Abgeschlossen am .*Frau Müller/)).toBeVisible()
  await expect(page.getByRole('img', { name: 'Unterschrift Auftraggeber' })).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Zeile erfassen' })).toHaveCount(0)

  // The quote now shows the measured quantity.
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Dokumente' }).click()
  await page.getByRole('link', { name: /Angebot/ }).click()
  await expect(page.getByText('aus Aufmaß', { exact: true })).toBeVisible()
  await expect(page.locator('.position--item .calc')).toContainText('36,44 m²')
})

test('Bautagebuch: daily report with weather, team, work, photo and signature', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(90_000)

  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Bautagebuch' }).click()
  await page.getByRole('button', { name: 'Neuer Tagesbericht' }).click()
  await page.getByLabel('Datum').fill('2026-11-09')
  await page.getByRole('button', { name: 'Tagesbericht anlegen' }).click()
  await expect(page.getByRole('heading', { name: /Bautagesbericht – 09\.11\.2026/ })).toBeVisible()
  await expect(page).toHaveURL(/\/berichte\/[0-9a-f-]{36}$/)

  // Team and working hours are prefilled (Monday: 07:00–16:00 minus 30 min).
  await expect(page.getByLabel('Name', { exact: true }).first()).toHaveValue(ADMIN.name)
  await expect(page.getByLabel('Stunden', { exact: true }).first()).toHaveValue('8,5')

  await page.getByText('Regen', { exact: true }).click()
  await page.getByLabel('Temperatur min. (°C)').fill('3')
  await page.getByLabel('Temperatur max. (°C)').fill('8,5')
  await page.getByLabel('Tätigkeit').first().fill('Wände grundiert')
  const services = page.getByRole('group', { name: 'Ausgeführte Leistungen' })
  await services.getByRole('button', { name: '+ Zeile' }).click()
  await services.getByLabel('Bezeichnung').fill('Grundierung Bad')
  await services.getByLabel('Menge').fill('36,44')
  await services.getByLabel('Einheit').selectOption({ label: 'm²' })
  await page
    .getByLabel('Besondere Vorkommnisse')
    .fill('Wasserleitung undicht, Arbeiten 1 h unterbrochen.')
  await page
    .locator('input[type=file][capture]')
    .setInputFiles({ name: 'Leck.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByRole('img', { name: 'Leck.png' })).toBeVisible()
  await page.getByRole('button', { name: 'Bericht speichern' }).click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/bautagebuch.png`, fullPage: true })

  // Signing locks the report; the signature from the account is already there.
  await expect(page.getByText('Aus Ihrem Konto übernommen.')).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Unterschreiben und abschließen' }).click()
  await expect(page.getByText('Dieser Bericht ist unterschrieben und gesperrt.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bericht speichern' })).toHaveCount(0)
  await expect(
    page.getByText(new RegExp(`${ADMIN.name} \\(Auftragnehmer\\), unterschrieben am`)),
  ).toBeVisible()
  await expect(page.getByRole('img', { name: 'Unterschrift Auftragnehmer' })).toBeVisible()

  // The Bautagebuch of the project lists the day.
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await expect(page.getByText(/Mo\.?, 09\.11\.2026/)).toBeVisible()
  await expect(page.getByText(/Regen, 3 °C – 8,5 °C · 1 Person · 8,5 Std · 1 Foto/)).toBeVisible()
})
