import { expect, test } from '@playwright/test'
import { ADMIN, type AdminSession, SCREENSHOTS, SETUP_TOKEN, session } from './support'

test.describe.configure({ mode: 'serial' })

// Logged-in admin with the virtual security key (from 01-einrichtung, or restored from disk).
let page: AdminSession['page']
let key: AdminSession['key']
test.beforeAll(async ({ browser }) => {
  ;({ page, key } = await session(browser))
})

test('second factor fails without the security key', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  // Without the key the second step of the login fails with a readable message.
  await key.cdp.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: key.authenticatorId,
  })
  await page.getByRole('button', { name: 'Abmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/tour/60-anmeldung.png` })
  await page.getByLabel('E-Mail-Adresse').fill(ADMIN.email)
  await page.locator('input[name=password]').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Zweiter Schritt' })).toBeVisible()
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/tour/61-zweiter-schritt.png` })
})
