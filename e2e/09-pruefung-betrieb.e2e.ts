import { readFileSync } from 'node:fs'
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

test('Betrieb und Datenschutz: Betriebs-Check, Exporte, Auskunft und Löschen', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(90_000)
  // Betriebs-Check: all checks are listed, with the hint about e-mail warnings.
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.locator('#settings-section').selectOption('system')
  await expect(page.getByRole('heading', { name: 'Betriebs-Check' })).toBeVisible()
  const checks = page.locator('.op-check-list')
  for (const title of ['Sicherung', 'Sicherung außer Haus', 'Änderungsprotokoll (Hash-Kette)']) {
    await expect(checks.getByText(title, { exact: true })).toBeVisible()
  }
  await expect(
    page.getByText(/E-Mail-Warnungen bei Problemen|bekommen alle mit dem Recht/),
  ).toBeVisible()

  // Exporte: the DATEV export needs the numbers of the tax advisor first.
  await page.locator('#settings-section').selectOption('datev')
  await page.getByLabel('Beraternummer').fill('1001')
  await page.getByLabel('Mandantennummer').fill('20001')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()
  await page.locator('#settings-section').selectOption('system')
  // DATEV-Buchungsstapel with Belege and GoBD-Datenträgerüberlassung for this year.
  const year = new Date().getFullYear()
  await page.getByLabel('Von', { exact: true }).fill(`${year}-01-01`)
  await page.getByLabel('Bis', { exact: true }).fill(`${year}-12-31`)
  const exported = async (button: string) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: button }).click(),
    ])
    const path = await download.path()
    const bytes = readFileSync(path)
    return { name: download.suggestedFilename(), bytes }
  }
  const datev = await exported('DATEV-Buchungsstapel')
  expect(datev.name).toMatch(/\.zip$/)
  expect(datev.bytes.subarray(0, 2).toString()).toBe('PK')
  expect(datev.bytes.includes(Buffer.from('EXTF_'))).toBe(true)
  const gobd = await exported('GoBD-Export (Z3)')
  expect(gobd.bytes.subarray(0, 2).toString()).toBe('PK')
  expect(gobd.bytes.includes(Buffer.from('index.xml'))).toBe(true)
  await expectNoHorizontalScroll(page)

  // Datenschutz: Auskunft for the customer with invoices, a contact without invoices is erased.
  await page.getByRole('button', { name: 'Kontakte' }).click()
  const editor = page.locator('.contact-editor')
  await page.getByRole('button', { name: /^Wohnbau Nord eG/ }).click()
  await expect(editor.getByRole('heading', { name: 'Datenschutz' })).toBeVisible()
  const [report] = await Promise.all([
    page.waitForEvent('download'),
    editor.getByRole('button', { name: 'Auskunft herunterladen' }).click(),
  ])
  expect(report.suggestedFilename()).toMatch(/^Auskunft_DSGVO_\d{4}-\d{2}-\d{2}\.json$/)
  const auskunft = JSON.parse(readFileSync(await report.path(), 'utf8'))
  expect(auskunft.Stammdaten.Firma).toBe('Wohnbau Nord eG')
  expect(auskunft.Dokumente.length).toBeGreaterThan(0)
  await editor.getByRole('button', { name: 'Schließen' }).click()

  const create = page.locator('form.inline-form')
  await create.getByLabel('Name der Organisation').fill('Interessent ohne Auftrag GmbH')
  await create.getByRole('button', { name: 'Speichern' }).click()
  await expect(editor.getByRole('heading', { name: /Interessent ohne Auftrag GmbH/ })).toBeVisible()
  await editor.getByRole('button', { name: 'Löschen (DSGVO) …' }).click()
  await expect(editor.getByText(/sofort und endgültig anonymisiert/)).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/datenschutz.png`, fullPage: true })
  await editor.getByRole('button', { name: 'Endgültig löschen' }).click()
  await expect(editor.getByText('Der Kontakt wurde gelöscht (anonymisiert).')).toBeVisible()
  await expect(editor.getByRole('heading', { name: /Gelöschter Kontakt/ })).toBeVisible()
  await expect(editor.getByText(/Gelöscht \(anonymisiert\) am/)).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Löschen (DSGVO) …' })).toHaveCount(0)
})
