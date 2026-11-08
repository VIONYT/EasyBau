import { type BrowserContext, expect, type Page, test } from '@playwright/test'

/**
 * Core flow on a phone-sized screen against a fresh stack:
 * setup → forced 2FA → register a security key (virtual YubiKey) → work → invite a person
 * → accept the invitation → passwordless login with the key.
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

test('setup, security key, user management and passwordless login', async ({ browser }) => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  const context = await browser.newContext()
  const page = await context.newPage()
  const key = await attachVirtualYubikey(context, page)

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

  // Without the key the second step fails with a readable message.
  await key.cdp.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: key.authenticatorId,
  })
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await page.getByLabel('E-Mail-Adresse').fill(ADMIN.email)
  await page.locator('input[name=password]').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Zweiter Schritt' })).toBeVisible()
  await context.close()
})
