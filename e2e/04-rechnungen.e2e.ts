import { expect, test } from '@playwright/test'
import { createCustomer, createOrderConfirmation, createProject } from './fixtures'
import {
  type AdminSession,
  expectNoHorizontalScroll,
  SCREENSHOTS,
  SETUP_TOKEN,
  SUPPLIER_XRECHNUNG,
  session,
} from './support'

test.describe.configure({ mode: 'serial' })

// Logged-in admin with the virtual security key (from 01-einrichtung, or restored from disk).
let page: AdminSession['page']
// Own data (C.11): a customer still without address (the invoice check names it), a project and
// a finalized Auftragsbestätigung to invoice from.
const CUSTOMER = 'Wohnungsbau Kastanienhof eG'
const PROJECT = 'Fassade Kastanienhof'
let ab = { id: '', number: '' }
test.beforeAll(async ({ browser }) => {
  ;({ page } = await session(browser))
  if (!SETUP_TOKEN) return
  const customerId = await createCustomer(page, CUSTOMER, { withAddress: false })
  const project = await createProject(page, PROJECT, customerId)
  ab = await createOrderConfirmation(page, project.id, customerId, [
    { shortText: 'Fassade reinigen', quantity: '120', unitPriceCents: 1450 },
    { shortText: 'Fassadenanstrich', quantity: '120', unitPriceCents: 2890, laborMinutes: 20 },
  ])
})

test('Rechnung: Pflichtangaben, Festschreiben und Korrigieren per Storno', async () => {
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN must be set for a fresh stack')
  test.setTimeout(120_000)

  // Rechnung aus der Auftragsbestätigung
  await page.getByRole('button', { name: 'Projekte' }).click()
  await page.getByRole('link', { name: PROJECT }).click()
  await page.getByRole('button', { name: 'Dokumente' }).click()
  await page.getByRole('button', { name: 'Neues Dokument' }).click()
  await page.getByRole('radio', { name: 'Rechnung', exact: true }).check()
  const source = page.getByLabel('Positionen übernehmen aus')
  const abOption = await source.locator('option', { hasText: ab.number }).getAttribute('value')
  await source.selectOption(abOption as string)
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
  await page.getByRole('button', { name: CUSTOMER }).click()
  const editor = page.locator('.contact-editor')
  await editor.getByLabel('Straße und Hausnummer').fill('Kastanienhof 12')
  await editor.getByLabel('PLZ').fill('30159')
  await editor.getByLabel('Ort').fill('Hannover')
  await editor.getByLabel('Format').selectOption('xrechnung_ubl')
  await editor.getByLabel('E-Mail für E-Rechnungen').fill('rechnung@kastanienhof.example')
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
  const preview = page.getByText('Die Rechnung erhält die Nummer')
  await expect(preview).toContainText(/R-\d+/)
  const number = /R-\d+/.exec((await preview.textContent()) ?? '')?.[0] as string
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/rechnung-festschreiben.png`, fullPage: true })
  await expect(page.getByText(/E-Rechnung .* KoSIT-Validator geprüft/)).toBeVisible()
  await page.getByRole('button', { name: 'Jetzt festschreiben' }).click()
  await expect(page.getByText(new RegExp(`^${number}`))).toBeVisible()
  await expect(page.getByText('Fertiggestellt', { exact: true })).toBeVisible()
  // E-Rechnung: ZUGFeRD im PDF und XRechnung, beide vom KoSIT-Validator geprüft
  await expect(page.getByText(/E-Rechnung geprüft \(ZUGFeRD, XRechnung UBL\)/)).toBeVisible()
  const invoiceId = invoiceUrl.split('/').pop() as string
  const xrechnung = await page.request.get(`/api/v1/documents/${invoiceId}/einvoice/xrechnung_ubl`)
  expect(xrechnung.status()).toBe(200)
  expect(await xrechnung.text()).toContain(`<cbc:ID>${number}</cbc:ID>`)
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
  await expect(page.getByRole('link', { name: new RegExp(number) })).toContainText('angemahnt')
  await page.getByLabel('Status').selectOption('dunned')
  await expect(page.getByRole('link', { name: new RegExp(number) })).toBeVisible()
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

  // Im Projekt: die Rechnung gesperrt und ausgegraut, Stornorechnung mit eigener Nummer
  await page.getByRole('link', { name: PROJECT }).click()
  await expect(page.getByText(/storniert durch R-\d+/)).toBeVisible()
  await expect(page.locator('.is-cancelled .locked-number')).toHaveText(number)
  await expect(page.getByText(`Storno zu Rechnung ${number}`).first()).toBeVisible()
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/rechnung-storno.png`, fullPage: true })
})

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
  const project = await target.locator('option', { hasText: PROJECT }).getAttribute('value')
  await target.selectOption(project as string)
  await page.getByLabel('Kostenart').selectOption('material')
  await expect(page.getByLabel('Netto-Betrag')).toHaveValue('400,00')
  await expectNoHorizontalScroll(page)
  if (SCREENSHOTS)
    await page.screenshot({ path: `${SCREENSHOTS}/eingangsrechnung-pruefen.png`, fullPage: true })
  await page.getByRole('button', { name: 'Prüfung bestätigen' }).click()
  await expect(page.locator('.invoice-head .chip')).toHaveText('offen')
  await expect(page.getByText(PROJECT).first()).toBeVisible()

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

  // Filter Zuweisung and Zeitraum (P2.4)
  const filterTarget = page.getByLabel('Zuweisung', { exact: true })
  const ownProject = await filterTarget
    .locator('option', { hasText: PROJECT })
    .getAttribute('value')
  await filterTarget.selectOption(ownProject as string)
  await expect(page.getByRole('link', { name: /Holzhandel Süd GmbH/ })).toBeVisible()
  await page.getByLabel('Rechnungsdatum von').fill('2030-01-01')
  await expect(page.getByRole('link', { name: /Holzhandel Süd GmbH/ })).toHaveCount(0)
  await page.getByLabel('Rechnungsdatum von').fill('')
  await filterTarget.selectOption('')

  // PDF: preview next to the data (frame allowed by the proxy only for the original)
  await page.getByRole('button', { name: 'Alle' }).click()
  await page.locator('input[type="file"]').setInputFiles({
    name: 'lieferschein-rechnung.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    ),
  })
  const frame = page.locator('iframe.incoming-pdf')
  await expect(frame).toBeVisible()
  const framed = await page.request.get((await frame.getAttribute('src')) as string)
  expect(framed.headers()['x-frame-options']).toBe('SAMEORIGIN')
  expect(framed.headers()['content-security-policy']).toContain("frame-ancestors 'self'")
  const app = await page.request.get('/')
  expect(app.headers()['x-frame-options']).toBe('DENY')
  await expectNoHorizontalScroll(page)

  // Rechnungseingang per E-Mail: not enabled by the operator in this stack
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await page.locator('#settings-section').selectOption({ label: 'Rechnungseingang (E-Mail)' })
  await expect(page.getByText(/nicht freigeschaltet/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jetzt abrufen' })).toHaveCount(0)
  await expectNoHorizontalScroll(page)
})
