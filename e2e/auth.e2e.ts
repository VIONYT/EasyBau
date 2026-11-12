import { type BrowserContext, expect, type Page, test } from '@playwright/test'

/**
 * Core flows on a phone-sized screen against a fresh stack:
 * 1. setup → forced 2FA → register a security key (virtual YubiKey) → invite a person
 *    → accept the invitation → passwordless login with the key.
 * 2. create a project → quote with positions → upload into the project filing (Ablage).
 */

const SETUP_TOKEN = process.env.SETUP_TOKEN ?? ''
const ADMIN = {
  name: 'Erika Meister',
  email: 'erika@example.test',
  password: 'ein-langes-passwort',
}

/** Attaches a virtual FIDO2 security key (USB, resident keys, PIN) like a YubiKey 5. */
async function attachVirtualYubikey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId }
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expect(overflow).toBe(false)
}

/** Draws a signature-like stroke with the mouse into the pad with this accessible name. */
async function drawSignature(page: Page, name: string) {
  const pad = page.getByRole('img', { name })
  await pad.scrollIntoViewIfNeeded()
  const box = await pad.boundingBox()
  if (!box) throw new Error(`signature pad ${name} not visible`)
  const y = box.y + box.height * 0.6
  await page.mouse.move(box.x + 30, y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + 30 + i * 14, y - Math.sin(i / 1.5) * 30, { steps: 2 })
  }
  await page.mouse.up()
  await expect(page.getByText('Unterschrift erfasst.').first()).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

// Shared between the serial tests: the logged-in admin with the virtual key.
let context: BrowserContext
let page: Page
let key: Awaited<ReturnType<typeof attachVirtualYubikey>>
const SCREENSHOTS = process.env.SCREENSHOT_DIR

test.afterAll(async () => {
  await context?.close()
})

test('setup, security key, user management and passwordless login', async ({ browser }) => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  context = await browser.newContext()
  page = await context.newPage()
  key = await attachVirtualYubikey(context, page)

  // Ersteinrichtung
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Ersteinrichtung' })).toBeVisible()
  await page.getByLabel('Einrichtungscode').fill(SETUP_TOKEN)
  await page.getByLabel('Firmenname mit Rechtsform').fill('Muster Bau GmbH')
  await page.getByLabel('Ihr Name').fill(ADMIN.name)
  await page.getByLabel('E-Mail-Adresse').fill(ADMIN.email)
  await page.locator('input[name=password]').fill(ADMIN.password)
  await expectNoHorizontalScroll(page)
  await page.getByRole('button', { name: 'Einrichtung abschließen' }).click()

  // Admins are forced to set up a second factor first.
  await expect(page.getByRole('heading', { name: 'Sicherheit', exact: true })).toBeVisible()
  await expect(page.getByText('müssen Sie einen zweiten Faktor einrichten')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Projekte' })).toHaveCount(0)

  // Register the virtual YubiKey.
  await page.getByLabel('Name des Schlüssels').fill('YubiKey Büro')
  await page.getByRole('button', { name: 'Schlüssel hinzufügen' }).click()
  await expect(page.getByText('YubiKey Büro')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Projekte' })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // TOTP setup shows a QR code (not completed here).
  await page.getByRole('button', { name: 'App einrichten' }).click()
  await expect(page.getByRole('img', { name: 'Authenticator-App' })).toBeVisible()

  // Benutzerverwaltung: invite a site worker.
  await page.getByRole('button', { name: 'Benutzer' }).click()
  await page.getByLabel('E-Mail-Adresse').fill('monteur@example.test')
  await page.getByLabel('Name (optional)').fill('Max Monteur')
  await page.getByLabel('Rolle').selectOption('team_member')
  await page.getByRole('button', { name: 'Einladung erstellen' }).click()
  const link = (await page.locator('code.secret').textContent()) ?? ''
  expect(link).toMatch(/\/einladung#/)
  await expect(page.getByText('Offene Einladungen')).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Accept the invitation in a separate browser (the invited person).
  const invited = await browser.newContext()
  const invitedPage = await invited.newPage()
  await invitedPage.goto(new URL(link).pathname + new URL(link).hash)
  await expect(invitedPage.getByText('Muster Bau GmbH')).toBeVisible()
  await invitedPage.locator('input[name=password]').fill('monteur-passwort-1')
  await invitedPage.getByRole('button', { name: 'Einladung annehmen' }).click()
  await expect(invitedPage.getByRole('heading', { name: 'Projekte' })).toBeVisible()
  await expect(invitedPage.getByRole('button', { name: 'Benutzer' })).toHaveCount(0)
  await invited.close()

  await page.getByRole('button', { name: 'Benutzer' }).click()
  await expect(page.getByText('Max Monteur')).toBeVisible()

  // Log out and log back in without password, only with the security key (+ PIN).
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
  await page.getByRole('button', { name: 'Mit Sicherheitsschlüssel oder Passkey anmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Projekte' })).toBeVisible()

  // Password + key as second factor.
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
  await page.getByLabel('E-Mail-Adresse').fill(ADMIN.email)
  await page.locator('input[name=password]').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Zweiter Schritt' })).toBeVisible()
  await page.getByRole('button', { name: 'Mit Sicherheitsschlüssel bestätigen' }).click()
  await expect(page.getByRole('heading', { name: 'Projekte' })).toBeVisible()
})

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

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

/** DATANORM sample in the DOS character set (CP850), as wholesalers deliver it. */
function datanormFile(): Buffer {
  const text = [
    'V;050;01112026;Baustoff Nord GmbH;Testkatalog;;EUR',
    'A;N;4711;00;Dispersionsfarbe weiß;12,5 l;1;0;Eim;4599;R10;MAL;T4711',
    'B;N;4711;FARBE WEISS;;;;;4012345678901;;',
    'T;N;T4711;1;0;Hochdeckende Innenfarbe;2;0;für Wand und Decke',
    'A;N;0815;00;Spax Schraube 4x40;;2;2;Stck;1234;;;',
    'A;N;9999;00;Kleber im Fass;;1;0;Fass;1000;;;',
  ].join('\r\n')
  const cp850: Record<string, number> = { ä: 0x84, ö: 0x94, ü: 0x81, ß: 0xe1 }
  return Buffer.from([...text].map((ch) => cp850[ch] ?? ch.charCodeAt(0)))
}

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

test('Rechnung: Pflichtangaben, Festschreiben und Korrigieren per Storno', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  // Rechnung aus der Auftragsbestätigung
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Dokumente' }).click()
  await page.getByRole('button', { name: 'Neues Dokument' }).click()
  await page.getByRole('radio', { name: 'Rechnung', exact: true }).check()
  const source = page.getByLabel('Positionen übernehmen aus')
  const ab = await source.locator('option', { hasText: 'AB-00101' }).getAttribute('value')
  await source.selectOption(ab as string)
  await page.getByRole('button', { name: 'Dokument erstellen' }).click()
  await expect(page.getByRole('heading', { name: 'Rechnung', exact: true })).toBeVisible()
  const invoiceUrl = page.url()

  // Pflichtangaben fehlen: der Dialog nennt sie, Festschreiben ist gesperrt
  await page.getByRole('button', { name: 'Rechnung festschreiben …' }).click()
  const missing = page.getByRole('alert')
  await expect(missing).toContainText('Anschrift Ihrer Firma')
  await expect(missing).toContainText('Empfänger mit vollständiger Anschrift fehlt.')
  await expect(page.getByRole('button', { name: 'Jetzt festschreiben' })).toBeDisabled()
  await page.getByRole('button', { name: 'Abbrechen' }).click()

  // Firmenanschrift, Steuernummer und Kundenanschrift ergänzen
  expect(
    (
      await page.request.patch('/api/v1/settings/company', {
        data: {
          street: 'Werkstraße 2',
          postalCode: '30169',
          city: 'Hannover',
          taxNumber: '25/123/45678',
          email: 'buero@muster-bau.example',
          phone: '0511 123456',
          iban: 'DE89370400440532013000',
        },
      })
    ).status(),
  ).toBe(200)
  // Kundenanschrift und E-Rechnungsdaten im Kontakt (XRechnung an die E-Rechnungs-Adresse)
  await page.getByRole('button', { name: 'Kontakte' }).click()
  await page.getByRole('button', { name: /Wohnbau Nord eG/ }).click()
  const editor = page.locator('.contact-editor')
  await editor.getByLabel('Straße und Hausnummer').fill('Lindenweg 4')
  await editor.getByLabel('PLZ').fill('30159')
  await editor.getByLabel('Ort').fill('Hannover')
  await editor.getByLabel('Format').selectOption('xrechnung_ubl')
  await editor.getByLabel('E-Mail für E-Rechnungen').fill('rechnung@wohnbau-nord.example')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/kontakt-erechnung.png`, fullPage: true })
  await editor.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Kontakt gespeichert.')).toBeVisible()
  await page.goto(invoiceUrl)
  // Rechnungsdatum 30 Tage zurück: bei 14 Tagen Zahlungsziel ist die Rechnung überfällig (Mahnung).
  const invoiceDate = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  await page.getByLabel('Datum', { exact: true }).fill(invoiceDate)
  await page.getByLabel('Leistung von').fill('2026-10-01')
  await page.getByLabel('Leistung bis').fill('2026-10-31')
  await page.getByRole('button', { name: 'Speichern', exact: true }).first().click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()

  // Festschreiben mit Vorschau der Nummer
  await page.getByRole('button', { name: 'Rechnung festschreiben …' }).click()
  await expect(page.getByText('Alle Pflichtangaben sind vorhanden.')).toBeVisible()
  await expect(page.getByText('Die Rechnung erhält die Nummer')).toContainText('R-00101')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/rechnung-festschreiben.png`, fullPage: true })
  await expect(page.getByText(/E-Rechnung .* KoSIT-Validator geprüft/)).toBeVisible()
  await page.getByRole('button', { name: 'Jetzt festschreiben' }).click()
  await expect(page.getByText(/^R-00101/)).toBeVisible()
  await expect(page.getByText('Fertiggestellt', { exact: true })).toBeVisible()
  // E-Rechnung: ZUGFeRD im PDF und XRechnung, beide vom KoSIT-Validator geprüft
  await expect(page.getByText(/E-Rechnung geprüft \(ZUGFeRD, XRechnung UBL\)/)).toBeVisible()
  const invoiceId = invoiceUrl.split('/').pop() as string
  const xrechnung = await page.request.get(`/api/v1/documents/${invoiceId}/einvoice/xrechnung_ubl`)
  expect(xrechnung.status()).toBe(200)
  expect(await xrechnung.text()).toContain('<cbc:ID>R-00101</cbc:ID>')
  const pdf = await page.request.get(`/api/v1/documents/${invoiceId}/pdf`)
  expect((await pdf.body()).toString('latin1')).toContain('/F (factur-x.xml)')
  // Revisionssicheres Archiv: the worker copies the originals into the archive (RustFS) with Object Lock.
  await expect(async () => {
    await page.reload()
    await expect(
      page.getByText(/Original revisionssicher archiviert \(unveränderbar bis 31\.12\.2036\)/),
    ).toBeVisible({
      timeout: 2000,
    })
  }).toPass({ timeout: 60_000 })

  // Zahlungen: Teilzahlung erfassen, Status und offene Forderung
  const receivable = page.locator('.receivable')
  await expect(receivable.locator('.chip')).toHaveText('überfällig')
  await receivable.getByRole('button', { name: 'Zahlung erfassen' }).click()
  await receivable.getByLabel('Betrag (€)').fill('100,00')
  await receivable.getByLabel('Verwendungszweck / Notiz').fill('Anzahlung')
  await expect(receivable.getByText(/Teilzahlung, danach noch offen/)).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/zahlung-erfassen.png`, fullPage: true })
  await receivable.getByRole('button', { name: 'Speichern' }).click()
  await expect(receivable.getByText('Anzahlung')).toBeVisible()
  await expect(receivable.locator('.chip')).toHaveText('überfällig')

  // Mahnwesen: Zahlungserinnerung mit Vorschau, festgeschrieben als PDF/A
  const dunning = page.locator('.dunning')
  await expect(dunning.getByText(/Nächste Stufe: Zahlungserinnerung/)).toBeVisible()
  await dunning.getByRole('button', { name: 'Zahlungserinnerung erstellen' }).click()
  await dunning.getByLabel('Mahngebühr (€)').fill('2,50')
  await expect(dunning.getByText('Mahngebühr', { exact: true })).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/mahnung-erstellen.png`, fullPage: true })
  await dunning.getByRole('button', { name: 'Zahlungserinnerung ausstellen' }).click()
  await expect(dunning.getByText(/^Zahlungserinnerung$/)).toBeVisible()
  await expect(receivable.locator('.chip')).toHaveText('angemahnt')
  await expect(dunning.getByText(/Die Frist der Zahlungserinnerung läuft noch/)).toBeVisible()
  const noticePdf = await dunning.getByRole('link', { name: 'PDF' }).getAttribute('href')
  const noticeFile = await page.request.get(noticePdf as string)
  expect(noticeFile.status()).toBe(200)
  expect((await noticeFile.body()).subarray(0, 5).toString()).toBe('%PDF-')

  // Rechnungsliste mit Status, Summen und Filter
  await page.getByRole('button', { name: 'Rechnungen', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Rechnungen', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /R-00101/ })).toContainText('angemahnt')
  await page.getByLabel('Status').selectOption('dunned')
  await expect(page.getByText('Rechnungen: 1')).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/rechnungsliste.png`, fullPage: true })
  await page.goto(invoiceUrl)
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/rechnung-erechnung.png`, fullPage: true })
  await expect(page.locator('.legal-notes')).toContainText('Zahlbar ohne Abzug bis')

  // Rechnung korrigieren: Storno mit eigener Nummer + neuer Entwurf
  await page.getByRole('button', { name: 'Rechnung korrigieren …' }).click()
  await page.getByLabel(/Grund für das Storno/).fill('Falscher Leistungszeitraum')
  await page.getByRole('button', { name: 'Stornieren und neuen Entwurf anlegen' }).click()
  await expect(page.getByRole('heading', { name: 'Rechnung', exact: true })).toBeVisible()
  await expect(page.getByText('Entwurf', { exact: true }).first()).toBeVisible()

  // Im Projekt: R-00101 gesperrt und ausgegraut, Stornorechnung R-00102
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await expect(page.getByText('storniert durch R-00102')).toBeVisible()
  await expect(page.locator('.is-cancelled .locked-number')).toHaveText('R-00101')
  await expect(page.getByText('Storno zu Rechnung R-00101').first()).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/rechnung-storno.png`, fullPage: true })
})

/** XRechnung (UBL) of a supplier as received by e-mail or download. */
const SUPPLIER_XRECHNUNG = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>HS-2026-0815</cbc:ID>
  <cbc:IssueDate>2026-11-02</cbc:IssueDate>
  <cbc:DueDate>2026-12-02</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>Lindenweg</cbc:BuyerReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>Holzhandel Süd GmbH</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Sägewerk 1</cbc:StreetName><cbc:CityName>Celle</cbc:CityName>
      <cbc:PostalZone>29221</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE811111111</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Muster Bau GmbH</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount><cbc:ID>DE02120300000000202051</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">76.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">400.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">76.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">400.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">400.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">476.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">476.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="MTQ">2</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">400.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Konstruktionsvollholz 60×120</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID>
      <cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">200.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`

test('Eingangsrechnung: XRechnung empfangen, prüfen, zuweisen, bestätigen und bezahlen', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(90_000)
  await page.getByRole('button', { name: 'Eingangsrechnungen' }).click()
  await expect(page.getByRole('heading', { name: 'Eingangsrechnungen' })).toBeVisible()
  await expect(page.getByText('Nichts zu prüfen.')).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'xrechnung-holz.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from(SUPPLIER_XRECHNUNG),
  })

  // One file: straight into the review, prefilled from the XML and shown readable
  await expect(
    page.getByRole('heading', { name: 'Holzhandel Süd GmbH · HS-2026-0815' }),
  ).toBeVisible()
  await expect(page.getByText(/E-Rechnung: XRechnung 3\.0/)).toBeVisible()
  await expect(page.getByRole('cell', { name: /Konstruktionsvollholz/ })).toBeVisible()
  await expect(page.getByLabel('Name des Lieferanten')).toHaveValue('Holzhandel Süd GmbH')
  await expect(page.getByLabel('Rechnungsnummer')).toHaveValue('HS-2026-0815')
  await expect(page.getByLabel('Brutto')).toHaveValue('476,00')
  await expect(
    page.getByText('Die Kosten sind noch keinem Projekt oder Betriebsbereich zugewiesen.'),
  ).toBeVisible()

  // Kostenzuweisung: the open net amount goes to the project
  await page.getByRole('button', { name: 'Zuweisung hinzufügen' }).click()
  const target = page.getByLabel('Zuweisung 1')
  const project = await target
    .locator('option', { hasText: 'Sanierung Lindenweg' })
    .getAttribute('value')
  await target.selectOption(project as string)
  await page.getByLabel('Kostenart').selectOption('material')
  await expect(page.getByLabel('Netto-Betrag')).toHaveValue('400,00')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/eingangsrechnung-pruefen.png`, fullPage: true })
  await page.getByRole('button', { name: 'Prüfung bestätigen' }).click()
  await expect(page.locator('.invoice-head .chip')).toHaveText('offen')
  await expect(page.getByText('Sanierung Lindenweg').first()).toBeVisible()

  // Zahlstatus
  await page.getByRole('button', { name: 'Als bezahlt markieren' }).click()
  await expect(page.locator('.invoice-head .chip')).toHaveText('bezahlt')
  await expect(page.getByText(/Bezahlt am/)).toBeVisible()
  const original = await page.request.get(
    `${new URL(page.url()).pathname.replace('/eingangsrechnungen/', '/api/v1/incoming-invoices/')}/original`,
  )
  expect(original.status()).toBe(200)
  expect((await original.body()).toString()).toBe(SUPPLIER_XRECHNUNG)

  // List with filter
  await page.getByRole('link', { name: '← Eingangsrechnungen' }).click()
  await page.getByRole('button', { name: 'Bezahlt' }).click()
  await expect(page.getByRole('link', { name: /Holzhandel Süd GmbH/ })).toContainText('bezahlt')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/eingangsrechnungen.png`, fullPage: true })
})

// Smallest valid PNG (1 × 1 px) as logo.
const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test('Offline auf der Baustelle: Aufmaß und Bautagebuch ohne Netz, danach übertragen', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  // In the office: a Leistungsaufmaß, then everything for the site onto the device
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Aufmaß', exact: true }).click()
  await page.getByRole('button', { name: 'Neues Aufmaßblatt' }).click()
  await page.getByRole('radio', { name: /Leistungsaufmaß/ }).check()
  await page.getByRole('button', { name: 'Aufmaßblatt anlegen' }).click()
  await expect(page.getByRole('heading', { name: 'Leistungsaufmaß 1' })).toBeVisible()
  const sheetUrl = page.url()
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Offline verfügbar machen' }).click()
  await expect(page.getByText(/sind auf dem Gerät gespeichert/)).toBeVisible()

  // On site without network: a measurement line …
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Aufmaß', exact: true }).click()
  await page.getByRole('link', { name: /Leistungsaufmaß 1/ }).click()
  await page.getByRole('button', { name: '+ Zeile erfassen' }).click()
  await page.getByLabel('Beschreibung').fill('Decke Flur')
  await page.getByLabel(/Formel oder Zahl/).fill('3,5*2')
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  await expect(page.getByText('Decke Flur')).toBeVisible()
  await expect(page.locator('.m-line .result').first()).toContainText('7')
  await expect(page.getByText('noch nicht übertragen')).toBeVisible()
  await expect(page.getByText(/^Offline – /)).toBeVisible()
  await expect(page.getByText('1 Änderung(en) warten auf Übertragung.')).toBeVisible()

  // … and a new Bautagesbericht
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Bautagebuch', exact: true }).click()
  await page.getByRole('button', { name: 'Neuer Tagesbericht' }).click()
  await page.getByLabel('Datum').fill('2026-11-10')
  await page.getByRole('button', { name: 'Tagesbericht anlegen' }).click()
  await expect(page.getByRole('heading', { name: /Bautagesbericht – 10\.11\.2026/ })).toBeVisible()
  await page.getByText('Sonnig', { exact: true }).click()
  await page.getByRole('button', { name: 'Bericht speichern' }).click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()
  await expect(page.getByText('3 Änderung(en) warten auf Übertragung.')).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/offline.png`, fullPage: true })

  // Back online: the outbox is sent in order, the server has everything
  await context.setOffline(false)
  await expect(page.locator('.offline-bar')).toHaveCount(0, { timeout: 30_000 })
  await page.goto(sheetUrl)
  await expect(page.getByText('Decke Flur')).toBeVisible()
  await expect(page.locator('.m-line .result').first()).toContainText('7')
  await expect(page.getByText('noch nicht übertragen')).toHaveCount(0)
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Bautagebuch', exact: true }).click()
  await expect(page.getByText(/Di\.?, 10\.11\.2026/)).toBeVisible()
  await expect(page.getByText(/^Sonnig/)).toBeVisible()
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

  // At the finalized Stornorechnung: the panel explains that SMTP is not set up in this stack
  await page.getByRole('button', { name: 'Rechnungen', exact: true }).click()
  await page.getByRole('link', { name: /R-00102/ }).click()
  await expect(page.getByRole('heading', { name: 'Per E-Mail senden' })).toBeVisible()
  await expect(page.getByText(/E-Mail-Versand ist nicht eingerichtet/)).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Mahnvorschläge: nothing due in this stack (the dunned invoice was cancelled)
  await page.getByRole('button', { name: 'Rechnungen', exact: true }).click()
  await page.getByLabel('Mahnung fällig (Mahnvorschläge)').check()
  await expect(page.getByText('Keine Rechnungen für diesen Filter.')).toBeVisible()
  await expect(page.getByRole('button', { name: /Mahnlauf starten/ })).toHaveCount(0)
  await expectNoHorizontalScroll(page)
})

test('Regiebericht in die Rechnung, Nachtrag aus dem Bautagebuch, Vertragssumme', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  // Regiebericht: Stunden, Leistungszeitraum, Unterschrift von Auftragnehmer und Auftraggeber
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
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
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
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
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Bautagebuch' }).click()
  await page.getByText(/Mo\.?, 09\.11\.2026/).click()
  await page.getByRole('button', { name: 'Nachtrag anlegen' }).click()
  await expect(page.getByRole('heading', { name: 'Nachweise' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Bautagesbericht vom 09.11.2026' })).toBeVisible()
  await expect(page.getByText(/Wasserleitung undicht/).first()).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Projektübersicht: Vertragssumme mit dem Nachtrag (Entwurf zählt nicht)
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Übersicht', exact: true }).click()
  const contract = page.locator('section.contract')
  await expect(contract.getByRole('heading', { name: 'Vertragssumme' })).toBeVisible()
  await expect(contract.getByText('Hauptauftrag', { exact: true })).toBeVisible()
  await expect(contract.getByText(/N0\d/).first()).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/vertragssumme.png`, fullPage: true })
})

test('Briefpapier: WYSIWYG-Editor nach DIN 5008 B und Druckansicht', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.locator('#settings-section').selectOption({ label: 'Briefpapier' })
  await expect(page.getByRole('heading', { name: 'Briefpapier' })).toBeVisible()
  await expect(page.locator('.letter-sheet .letter-sender')).toContainText('Muster Bau GmbH')

  // Logo hochladen, Firmennamen per Tastatur verschieben, Akzentfarbe ändern
  await page.locator('.file-button input[type=file]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: LOGO_PNG,
  })
  await expect(page.locator('.letter-sheet .letter-logo')).toBeVisible()
  const name = page.getByRole('button', { name: /^Textfeld: \{Firma\}/ })
  await name.focus()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByLabel('Oben (mm)')).toHaveValue('20')
  await page.getByLabel('Akzentfarbe').fill('#8a1c1c')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/briefpapier-editor.png`, fullPage: true })
  await page.getByRole('button', { name: 'Speichern', exact: true }).click()
  await expect(page.getByText('Briefpapier gespeichert.')).toBeVisible()

  // Druckansicht eines Dokuments: Briefkopf, Anschriftfeld und Fußzeile nach DIN 5008 B
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: /Sanierung Lindenweg/ }).click()
  await page.getByRole('button', { name: 'Dokumente' }).click()
  await page
    .getByRole('link', { name: /^Rechnung/ })
    .last()
    .click()
  await page.getByRole('link', { name: 'Vorschau / Drucken' }).click()
  await expect(page.locator('.letter-sheet .letter-logo')).toBeVisible()
  await expect(page.locator('.letter-recipient')).toContainText('Lindenweg 4')
  await expect(page.locator('.letter-footer')).toContainText('Werkstraße 2')
  // PDF/A from Typst on the server (DIN 5008 Form B, A4)
  const pdfLink = page.getByRole('link', { name: 'PDF/A herunterladen' })
  const pdf = await page.request.get((await pdfLink.getAttribute('href')) as string)
  expect(pdf.status()).toBe(200)
  expect(pdf.headers()['content-type']).toBe('application/pdf')
  const bytes = await pdf.body()
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(bytes.toString('latin1')).toMatch(/pdfaid:part(>|=")3/)

  // Aufmaßblatt und Bautagesbericht des Projekts ebenfalls als PDF/A
  const projects = await (await page.request.get('/api/v1/projects?q=Lindenweg')).json()
  const projectId = (projects.items ?? projects)[0].id as string
  const sheets = await (
    await page.request.get(`/api/v1/projects/${projectId}/measurement-sheets`)
  ).json()
  const reports = await (await page.request.get(`/api/v1/projects/${projectId}/reports`)).json()
  for (const url of [
    `/api/v1/measurement-sheets/${sheets[0].id}/pdf`,
    `/api/v1/reports/${reports[0].id}/pdf`,
  ]) {
    const res = await page.request.get(url)
    expect(res.status(), url).toBe(200)
    expect((await res.body()).toString('latin1')).toMatch(/pdfaid:part(>|=")3/)
  }
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/briefpapier-druck.png`, fullPage: true })
})

test('Prüfung: Änderungsprotokoll, Hash-Kette und befristeter Prüferzugang', async ({
  browser,
}) => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  await page.getByRole('button', { name: 'Prüfung' }).click()
  await expect(page.getByRole('heading', { name: 'Prüfung', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Kette jetzt prüfen' }).click()
  await expect(page.getByText(/Kette vollständig und unverändert/)).toBeVisible()
  // Änderungsprotokoll: the payment recorded earlier, with its fields.
  await page.getByLabel('Bereich', { exact: true }).selectOption('payment')
  const entry = page.locator('.audit-events li').filter({ hasText: 'Angelegt · Zahlungen' }).first()
  await entry.locator('summary').click()
  await expect(entry.getByRole('row', { name: /amount_cents/ })).toContainText('10000')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/pruefung.png`, fullPage: true })

  // Prüfer (Steuerberatung/Betriebsprüfung): only with an end date, read-only.
  await page.getByRole('button', { name: 'Benutzer' }).click()
  await page.getByLabel('E-Mail-Adresse').fill('pruefer@finanzamt.example')
  await page.getByLabel('Rolle', { exact: true }).selectOption('auditor')
  await expect(page.getByLabel(/Zugang bis/)).toBeVisible()
  await page.getByRole('button', { name: 'Einladung erstellen' }).click()
  const link = (await page.locator('code.secret').textContent()) ?? ''
  await expect(page.getByText(/Zugang bis/).first()).toBeVisible()
  const auditor = await browser.newContext()
  const auditorPage = await auditor.newPage()
  await auditorPage.goto(new URL(link).pathname + new URL(link).hash)
  await auditorPage.locator('input[name=displayName]').fill('Paula Prüferin')
  await auditorPage.locator('input[name=password]').fill('pruefer-passwort-1')
  await auditorPage.getByRole('button', { name: 'Einladung annehmen' }).click()
  await expect(auditorPage.getByRole('button', { name: 'Prüfung' })).toBeVisible()
  await expect(auditorPage.getByRole('button', { name: 'Einstellungen' })).toHaveCount(0)
  await expect(auditorPage.getByRole('button', { name: 'Benutzer' })).toHaveCount(0)
  await auditorPage.getByRole('button', { name: 'Prüfung' }).click()
  await expect(auditorPage.getByText(/Ihr Zugang ist befristet/)).toBeVisible()
  await expect(auditorPage.getByRole('heading', { name: 'Exporte' })).toBeVisible()
  await expectNoHorizontalScroll(auditorPage)
  await auditor.close()
})

test('second factor fails without the security key', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  // Without the key the second step of the login fails with a readable message.
  await key.cdp.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: key.authenticatorId,
  })
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
  await page.getByLabel('E-Mail-Adresse').fill(ADMIN.email)
  await page.locator('input[name=password]').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Zweiter Schritt' })).toBeVisible()
})
