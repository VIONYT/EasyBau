import { expect, test } from '@playwright/test'
import {
  ADMIN,
  type AdminSession,
  attachVirtualYubikey,
  expectNoHorizontalScroll,
  rememberSession,
  SCREENSHOTS,
  SETUP_TOKEN,
} from './support'

test.describe.configure({ mode: 'serial' })

let context: AdminSession['context']
let page: AdminSession['page']
let key: AdminSession['key']

test('setup, security key, user management and passwordless login', async ({ browser }) => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  context = await browser.newContext()
  page = await context.newPage()
  key = await attachVirtualYubikey(context, page)

  // Ersteinrichtung
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Ersteinrichtung' })).toBeVisible()
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/tour/00-ersteinrichtung.png` })
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
  await expect(invitedPage.getByRole('heading', { name: 'Übersicht' })).toBeVisible()
  await expect(invitedPage.getByRole('button', { name: 'Benutzer' })).toHaveCount(0)
  await invited.close()

  await page.getByRole('button', { name: 'Benutzer' }).click()
  await expect(page.getByText('Max Monteur')).toBeVisible()

  // Log out and log back in without password, only with the security key (+ PIN).
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
  await page.getByRole('button', { name: 'Mit Sicherheitsschlüssel oder Passkey anmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Übersicht' })).toBeVisible()

  // Password + key as second factor.
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
  await page.getByLabel('E-Mail-Adresse').fill(ADMIN.email)
  await page.locator('input[name=password]').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Zweiter Schritt' })).toBeVisible()
  await page.getByRole('button', { name: 'Mit Sicherheitsschlüssel bestätigen' }).click()
  await expect(page.getByRole('heading', { name: 'Übersicht' })).toBeVisible()
  // The following files continue as this admin.
  await rememberSession({ context, page, key })
})
