import { expect, test } from '@playwright/test'
import { createProject } from './fixtures'
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
let context: AdminSession['context']
// Own project (C.11): independent of the other files.
const PROJECT = 'Dachausbau Ahornstraße'
test.beforeAll(async ({ browser }) => {
  ;({ page, context } = await session(browser))
  if (SETUP_TOKEN) await createProject(page, PROJECT, null)
})

test('Offline auf der Baustelle: Aufmaß und Bautagebuch ohne Netz, danach übertragen', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  // In the office: a Leistungsaufmaß, then everything for the site onto the device
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: PROJECT }).click()
  await page.getByRole('button', { name: 'Aufmaß', exact: true }).click()
  await page.getByRole('button', { name: 'Neues Aufmaßblatt' }).click()
  await page.getByRole('radio', { name: /Leistungsaufmaß/ }).check()
  await page.getByRole('button', { name: 'Aufmaßblatt anlegen' }).click()
  await expect(page.getByRole('heading', { name: 'Leistungsaufmaß 1' })).toBeVisible()
  const sheetUrl = page.url()
  await page.getByRole('link', { name: PROJECT }).click()
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
  await page.getByRole('link', { name: PROJECT }).click()
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
  await page.getByRole('link', { name: PROJECT }).click()
  await page.getByRole('button', { name: 'Bautagebuch', exact: true }).click()
  await expect(page.getByText(/Di\.?, 10\.11\.2026/)).toBeVisible()
  await expect(page.getByText(/^Sonnig/)).toBeVisible()
})
