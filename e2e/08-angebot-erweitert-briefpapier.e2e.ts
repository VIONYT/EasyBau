import { expect, test } from '@playwright/test'
import {
  type AdminSession,
  expectNoHorizontalScroll,
  LOGO_PNG,
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

test('Angebot: Bild-Position, Zielpreis, in Stammdaten speichern, Versionen, Stammdaten-CSV', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)
  // Setup via API: customer, project, quote with one calculated position
  const units = (await (await page.request.get('/api/v1/units')).json()) as {
    id: string
    symbol: string
  }[]
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id
  const customer = await (
    await page.request.post('/api/v1/contacts', {
      data: {
        kind: 'person',
        firstName: 'Paula',
        lastName: 'Preis',
        addresses: [{ kind: 'main', street: 'Am Markt 1', postalCode: '30159', city: 'Hannover' }],
      },
    })
  ).json()
  const project = await (
    await page.request.post('/api/v1/projects', {
      data: { name: 'Bad Preis', customerId: customer.id },
    })
  ).json()
  const quote = await (
    await page.request.post(`/api/v1/projects/${project.id}/documents`, { data: { type: 'quote' } })
  ).json()
  const withItem = await (
    await page.request.post(`/api/v1/documents/${quote.id}/items`, {
      data: {
        positionType: 'item',
        shortText: 'Fliesen verlegen',
        quantity: '20',
        unitId: unit('m²'),
      },
    })
  ).json()
  const calc = await page.request.post(
    `/api/v1/documents/${quote.id}/items/${withItem.items[0].id}/calculation`,
    {
      data: {
        lines: [
          {
            kind: 'labor',
            description: 'Fliesenleger',
            quantity: '60',
            unitId: unit('min'),
            unitCostCents: 5000,
          },
          {
            kind: 'material',
            description: 'Fliesen',
            quantity: '1',
            unitId: unit('m²'),
            unitCostCents: 2000,
          },
        ],
      },
    },
  )
  expect(calc.status()).toBe(200)
  await page.goto(`/dokumente/${quote.id}`)
  await expect(page.getByRole('heading', { name: 'Angebot', exact: true })).toBeVisible()

  // Bild-Position: upload into the project's Ablage and insert with caption
  await page.getByRole('button', { name: '+ Bild' }).click()
  await page.getByLabel('Oder neues Bild hochladen').setInputFiles({
    name: 'muster.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await expect(page.getByLabel('Bild aus der Projektablage')).toHaveValue(/[0-9a-f-]{36}/)
  await page.getByLabel('Bildunterschrift (optional)').fill('Fliesenmuster')
  await page.getByRole('button', { name: 'Bild einfügen' }).click()
  await expect(page.getByRole('img', { name: 'Fliesenmuster' })).toBeVisible()

  // Zielpreis: preview, then apply
  await page.getByText('Preis anpassen (Zielpreis)').click()
  await page.getByLabel('Ziel-Nettosumme').fill('1.500,00')
  await page.getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.getByText(/danach etwa 1\.500,00/)).toBeVisible()
  await page.getByRole('button', { name: 'Zielpreis übernehmen' }).click()
  await expect(page.getByText(/^Übernommen: netto/)).toBeVisible()
  await expectNoHorizontalScroll(page)

  // In Stammdaten speichern
  await page.getByRole('button', { name: 'In Stammdaten speichern: Fliesen verlegen' }).click()
  await expect(page.getByText('In Stammdaten', { exact: true })).toBeVisible()

  // Fertigstellen, then a new version
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Fertigstellen' }).click()
  await expect(page.getByRole('heading', { name: 'Versionen' })).toBeVisible()
  await page.getByRole('button', { name: 'Neue Version anlegen' }).click()
  await expect(page.getByText('Version 2 · Entwurf')).toBeVisible()
  await expect(page.getByRole('link', { name: /^Version 1 · A/ })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Stammdaten: the saved Leistung, CSV import of materials
  await page.getByRole('button', { name: 'Stammdaten', exact: true }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Fliesen verlegen' })).toBeVisible()
  await page.getByRole('button', { name: 'Materialien' }).click()
  await page.getByRole('button', { name: 'CSV importieren' }).click()
  await page.getByLabel('CSV-Datei').setInputFiles({
    name: 'material.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Art;Artikelnummer;Kurztext;Einheit;EK;VK\r\nMaterial;FK-1;Fliesenkleber;kg;1,20;2,10\r\n',
    ),
  })
  await page.getByRole('button', { name: 'Vorschau' }).click()
  await expect(page.getByText('1 neu, 0 aktualisiert, 0 übersprungen, 0 Fehler')).toBeVisible()
  await page.getByRole('button', { name: 'Importieren' }).click()
  await expect(page.getByText(/Import abgeschlossen/)).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Fliesenkleber' })).toBeVisible()
  await expectNoHorizontalScroll(page)
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
