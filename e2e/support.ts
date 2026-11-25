import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
} from '@playwright/test'

/**
 * Shared helpers, test data and the logged-in admin session of the E2E flows (e2e/NN-*.e2e.ts).
 * The files run in their numbered order against one fresh stack: 01-einrichtung sets up the
 * company and the admin with a virtual security key; the later files continue with that session
 * and with data created before (projects, documents …). The session is also stored on disk
 * (cookies + the key's credential, signing in again if it has ended), so a single file can be run
 * on its own once 01 has run – on a stack whose data fits that point of the flow (the files change
 * data, e.g. 06 saves its own e-mail template):
 *   BASE_URL=… SETUP_TOKEN=… pnpm test:e2e 04-rechnungen
 */

export const SETUP_TOKEN = process.env.SETUP_TOKEN ?? ''
export const ADMIN = {
  name: 'Erika Meister',
  email: 'erika@example.test',
  password: 'ein-langes-passwort',
}

/** Attaches a virtual FIDO2 security key (USB, resident keys, PIN) like a YubiKey 5. */
export async function attachVirtualYubikey(context: BrowserContext, page: Page) {
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

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expect(overflow).toBe(false)
}

/** Draws a signature-like stroke with the mouse into the pad with this accessible name. */
export async function drawSignature(page: Page, name: string) {
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

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** DATANORM sample in the DOS character set (CP850), as wholesalers deliver it. */
export function datanormFile(): Buffer {
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

/** XRechnung (UBL) of a supplier as received by e-mail or download. */
export const SUPPLIER_XRECHNUNG = `<?xml version="1.0" encoding="UTF-8"?>
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

// Smallest valid PNG (1 × 1 px) as logo.
export const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

export const SCREENSHOTS = process.env.SCREENSHOT_DIR

export interface AdminSession {
  context: BrowserContext
  page: Page
  key: { cdp: CDPSession; authenticatorId: string }
}

/** Outside test-results (Playwright empties that at every start); in .gitignore. */
const STORE = join(process.cwd(), '.e2e-session')
let current: AdminSession | null = null

/** After the setup: keep the admin session for the following files (and on disk). */
export async function rememberSession(s: AdminSession): Promise<void> {
  current = s
  mkdirSync(STORE, { recursive: true })
  await s.context.storageState({ path: join(STORE, 'state.json') })
  const { credentials } = await s.key.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: s.key.authenticatorId,
  })
  writeFileSync(join(STORE, 'credentials.json'), JSON.stringify(credentials))
}

/**
 * The logged-in admin: the same page as in 01-einrichtung while the worker runs, otherwise
 * restored from disk – session cookie plus the credential of the virtual security key.
 */
export async function session(browser: Browser): Promise<AdminSession> {
  if (current) return current
  const context = await browser.newContext({ storageState: join(STORE, 'state.json') })
  const page = await context.newPage()
  const key = await attachVirtualYubikey(context, page)
  const credentials = JSON.parse(readFileSync(join(STORE, 'credentials.json'), 'utf8'))
  for (const credential of credentials) {
    await key.cdp.send('WebAuthn.addCredential', {
      authenticatorId: key.authenticatorId,
      credential,
    })
  }
  await page.goto('/')
  // The stored session may have ended (e.g. 11-zweiter-faktor logs out): sign in again with the
  // password and the restored security key.
  const login = page.getByRole('heading', { name: 'Anmelden' })
  await expect(login.or(page.getByRole('button', { name: 'Abmelden' }))).toBeVisible()
  if (await login.isVisible()) {
    await page.getByLabel('E-Mail-Adresse').fill(ADMIN.email)
    await page.locator('input[name=password]').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
    await page.getByRole('button', { name: 'Mit Sicherheitsschlüssel bestätigen' }).click()
    await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible()
  }
  current = { context, page, key }
  return current
}
