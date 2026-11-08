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

  // Without the key the second step of the login fails with a readable message.
  await key.cdp.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: key.authenticatorId,
  })
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await page.getByLabel('E-Mail-Adresse').fill(ADMIN.email)
  await page.locator('input[name=password]').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Zweiter Schritt' })).toBeVisible()
})
