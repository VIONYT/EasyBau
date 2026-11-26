import { generateKeyPairSync } from 'node:crypto'
import type {
  IncomingInvoiceDetail,
  IncomingInvoiceList,
  IncomingMailLogEntry,
  IncomingMailLogPage,
  IncomingMailRun,
  IncomingMailSettings,
  ProjectFiguresDto,
} from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MailboxAccess, MailMessage } from './routes/incoming-mailbox.js'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Eingangsrechnungen ausbauen (P2.4): Rechnungseingang per E-Mail (fake mailbox instead of IMAP),
 * Kostenzuweisung je Rechnungsposition, Kreditorennummer im DATEV-Export, Projektkosten in den
 * Kennzahlen, Filter Zeitraum/Zuweisung.
 */
const UBL = (
  number: string,
  supplier = 'Trockenbau Süd GmbH',
) => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ID>${number}</cbc:ID>
  <cbc:IssueDate>2026-11-03</cbc:IssueDate>
  <cbc:DueDate>2026-11-17</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>Lindenweg</cbc:BuyerReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cbc:EndpointID schemeID="EM">rechnung@trockenbau.example</cbc:EndpointID>
    <cac:PartyName><cbc:Name>${supplier}</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Gipsweg 3</cbc:StreetName><cbc:CityName>Hildesheim</cbc:CityName>
      <cbc:PostalZone>31134</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE123456789</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Eingang Bau GmbH</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">1000.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">190.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">1190.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">1190.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="MTK">60</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">750.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Trockenbauwände</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">12.50</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
  <cac:InvoiceLine><cbc:ID>2</cbc:ID><cbc:InvoicedQuantity unitCode="H87">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">250.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Profile</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">25.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('Foto einer Rechnung'),
])

/** In-memory mailbox: unread messages, processed ones are remembered. */
const inbox: {
  messages: MailMessage[]
  done: number[]
  access: MailboxAccess | null
  fail: boolean
} = {
  messages: [],
  done: [],
  access: null,
  fail: false,
}

describe.skipIf(!process.env.DATABASE_URL)('Eingangsrechnungen ausbauen (integration)', () => {
  let h: Harness
  let admin: Client
  let projectId: string
  let supplierId: string

  beforeAll(async () => {
    h = await createHarness({
      requireAdminMfa: false,
      mailboxConnector: async (access) => {
        if (inbox.fail) throw Object.assign(new Error('auth'), { authenticationFailed: true })
        inbox.access = access
        return {
          unread: async (limit) =>
            inbox.messages.filter((m) => !inbox.done.includes(m.uid)).slice(0, limit),
          done: async (uid) => {
            inbox.done.push(uid)
          },
          close: async () => undefined,
        }
      },
    })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Eingang Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    projectId = (await admin.post('/api/v1/projects', { name: 'Lindenweg' })).json().id
    supplierId = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Trockenbau Süd GmbH',
        vatId: 'DE123456789',
      })
    ).json().id
  })

  afterAll(async () => {
    await h?.close()
  })

  it('stores the mailbox with an encrypted password', async () => {
    const empty = (await admin.get('/api/v1/settings/incoming-mail')).json() as IncomingMailSettings
    expect(empty).toMatchObject({ available: true, enabled: false, hasPassword: false, port: 993 })
    expect(
      (
        await admin.put('/api/v1/settings/incoming-mail', {
          enabled: true,
          host: 'imap.example.test',
        })
      ).statusCode,
    ).toBe(400)
    const saved = await admin.put('/api/v1/settings/incoming-mail', {
      enabled: true,
      host: 'imap.example.test',
      user: 'rechnungen@eingang.example',
      password: 'geheim-123',
      processedMailbox: 'Verarbeitet',
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({
      hasPassword: true,
      mailbox: 'INBOX',
      processedMailbox: 'Verarbeitet',
    })
    expect(JSON.stringify(saved.json())).not.toContain('geheim')
    const [row] = await h.adminSql<{ settings: string }[]>`select settings::text from tenant`
    expect(row?.settings).toContain('passwordEnc')
    expect(row?.settings).not.toContain('geheim-123')
    // Keep the password when it is left out
    const kept = await admin.put('/api/v1/settings/incoming-mail', {
      enabled: true,
      host: 'imap.example.test',
      user: 'rechnungen@eingang.example',
      processedMailbox: 'Verarbeitet',
    })
    expect(kept.json().hasPassword).toBe(true)
  })

  it('takes invoice attachments of unread e-mails into the review', async () => {
    inbox.messages = [
      {
        uid: 11,
        from: 'Trockenbau Süd <rechnung@trockenbau.example>',
        subject: 'Rechnung TS-200',
        attachments: [
          { filename: 'TS-200.xml', content: Buffer.from(UBL('TS-200')) },
          { filename: 'AGB.txt', content: Buffer.from('AGB') },
          { filename: 'logo.png', content: PNG, inline: true },
        ],
      },
      {
        uid: 12,
        from: 'Lieferant',
        subject: 'Foto',
        attachments: [{ filename: 'beleg.png', content: PNG }],
      },
      { uid: 13, from: 'Newsletter', subject: 'Angebote', attachments: [] },
    ]
    const res = await admin.post('/api/v1/settings/incoming-mail/run', {})
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      messages: 3,
      imported: 2,
      duplicates: 0,
      ignored: 2,
      failed: 0,
      error: null,
    } satisfies Partial<IncomingMailRun>)
    expect(inbox.done).toEqual([11, 12, 13])
    expect(inbox.access).toMatchObject({
      host: 'imap.example.test',
      password: 'geheim-123',
      processedMailbox: 'Verarbeitet',
    })
    const list = (
      await admin.get('/api/v1/incoming-invoices?status=review')
    ).json() as IncomingInvoiceList
    const fromMail = list.items.find((i) => i.invoiceNumber === 'TS-200')
    expect(fromMail).toMatchObject({
      receivedVia: 'email',
      emailFrom: 'Trockenbau Süd <rechnung@trockenbau.example>',
      emailSubject: 'Rechnung TS-200',
      supplierName: 'Trockenbau Süd GmbH',
    })
    // Protokoll je E-Mail: newest first, the result of every attachment.
    const log = (
      await admin.get('/api/v1/settings/incoming-mail/log')
    ).json() as IncomingMailLogPage
    expect(log.items.map((e) => [e.subject, e.outcome])).toEqual([
      ['Angebote', 'done'],
      ['Foto', 'done'],
      ['Rechnung TS-200', 'done'],
    ])
    const first = log.items[2] as IncomingMailLogEntry
    expect(first.from).toBe('Trockenbau Süd <rechnung@trockenbau.example>')
    expect(first.attachments).toEqual([
      { filename: 'TS-200.xml', result: 'imported', incomingInvoiceId: fromMail?.id },
      { filename: 'AGB.txt', result: 'ignored', reason: 'kein Rechnungsformat' },
      { filename: 'logo.png', result: 'ignored', reason: 'Bild im E-Mail-Text' },
    ])
    expect(log.items[0]?.attachments).toEqual([])
    const paged = (
      await admin.get('/api/v1/settings/incoming-mail/log?limit=2')
    ).json() as IncomingMailLogPage
    expect(paged.items).toHaveLength(2)
    const rest = (
      await admin.get(
        `/api/v1/settings/incoming-mail/log?limit=2&cursor=${encodeURIComponent(paged.nextCursor as string)}`,
      )
    ).json() as IncomingMailLogPage
    expect(rest.items.map((e) => e.subject)).toEqual(['Rechnung TS-200'])
    expect(rest.nextCursor).toBeNull()
    // Again: already received, nothing twice
    inbox.done = []
    const again = (
      await admin.post('/api/v1/settings/incoming-mail/run', {})
    ).json() as IncomingMailRun
    expect(again).toMatchObject({ imported: 0, duplicates: 2 })
    const latest = (
      await admin.get('/api/v1/settings/incoming-mail/log?limit=3')
    ).json() as IncomingMailLogPage
    expect(latest.items.find((e) => e.subject === 'Rechnung TS-200')?.attachments[0]).toEqual({
      filename: 'TS-200.xml',
      result: 'duplicate',
      incomingInvoiceId: fromMail?.id,
    })
    const settings = (
      await admin.get('/api/v1/settings/incoming-mail')
    ).json() as IncomingMailSettings
    expect(settings.lastRun?.duplicates).toBe(2)
    // A broken login is reported, nothing is marked as read
    inbox.fail = true
    const failed = (
      await admin.post('/api/v1/settings/incoming-mail/run', {})
    ).json() as IncomingMailRun
    expect(failed.error).toBe('Anmeldung am Postfach fehlgeschlagen (Benutzer oder Passwort).')
    inbox.fail = false
  })

  it('logs in to Microsoft 365 with OAuth2 (App registration) instead of a password', async () => {
    const incomplete = await admin.put('/api/v1/settings/incoming-mail', {
      enabled: true,
      auth: 'microsoft365',
      user: 'rechnungen@eingang.example',
      tenantId: 'eingang.onmicrosoft.com',
    })
    expect(incomplete.statusCode).toBe(400)
    expect(
      (
        await admin.put('/api/v1/settings/incoming-mail', {
          enabled: false,
          auth: 'microsoft365',
          tenantId: 'https://evil.example/x',
        })
      ).statusCode,
    ).toBe(400)
    const saved = await admin.put('/api/v1/settings/incoming-mail', {
      enabled: true,
      auth: 'microsoft365',
      user: 'rechnungen@eingang.example',
      tenantId: '0b2c6d8e-1f3a-4b5c-9d7e-123456789abc',
      clientId: '6a7b8c9d-0e1f-4a2b-8c3d-abcdef012345',
      clientSecret: 'client-geheim-456',
      clientSecretExpiresOn: '2026-11-30',
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({
      auth: 'microsoft365',
      clientId: '6a7b8c9d-0e1f-4a2b-8c3d-abcdef012345',
      hasClientSecret: true,
      hasPassword: true,
    } satisfies Partial<IncomingMailSettings>)
    expect(JSON.stringify(saved.json())).not.toContain('client-geheim')
    const [row] = await h.adminSql<{ settings: string }[]>`select settings::text from tenant`
    expect(row?.settings).not.toContain('client-geheim-456')

    inbox.messages = []
    const run = (
      await admin.post('/api/v1/settings/incoming-mail/run', {})
    ).json() as IncomingMailRun
    expect(run.error).toBeNull()
    expect(inbox.access).toMatchObject({
      host: 'outlook.office365.com',
      port: 993,
      secure: true,
      user: 'rechnungen@eingang.example',
      password: null,
      oauth: {
        tenantId: '0b2c6d8e-1f3a-4b5c-9d7e-123456789abc',
        clientId: '6a7b8c9d-0e1f-4a2b-8c3d-abcdef012345',
        clientSecret: 'client-geheim-456',
      },
    } satisfies Partial<MailboxAccess>)
    const notices = async () =>
      ((await admin.get('/api/v1/notices')).json() as { key: string; message: string }[]).filter(
        (n) => n.key.startsWith('incoming_mail'),
      )
    // Harness clock: 2026-11-08 → the secret expires within 30 days.
    expect((await notices()).map((n) => n.key)).toEqual(['incoming_mail_secret_expiring'])
    inbox.fail = true
    let refused: IncomingMailRun | undefined
    for (let i = 0; i < 3; i++) {
      refused = (await admin.post('/api/v1/settings/incoming-mail/run', {})).json()
    }
    expect(refused?.error).toMatch(/^Microsoft 365 hat die Anmeldung am Postfach abgelehnt/)
    expect(refused?.failedRuns).toBe(3)
    expect((await notices())[0]?.message).toMatch(
      /^Der Rechnungseingang per E-Mail schlägt seit 3 Abrufen fehl: Microsoft 365 hat/,
    )
    inbox.fail = false
    expect(
      ((await admin.post('/api/v1/settings/incoming-mail/run', {})).json() as IncomingMailRun)
        .failedRuns,
    ).toBe(0)
    expect((await notices()).map((n) => n.key)).toEqual(['incoming_mail_secret_expiring'])
    // Back to the password login of the first test (kept encrypted meanwhile).
    const back = await admin.put('/api/v1/settings/incoming-mail', {
      enabled: true,
      host: 'imap.example.test',
      user: 'rechnungen@eingang.example',
      processedMailbox: 'Verarbeitet',
    })
    expect(back.json()).toMatchObject({ auth: 'password', hasPassword: true })
  })

  it('logs in to Google Workspace with a service account (domain-wide delegation)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const keyFile = JSON.stringify({
      type: 'service_account',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      client_email: 'eingang@rechnungen.iam.gserviceaccount.com',
    })
    expect(
      (
        await admin.put('/api/v1/settings/incoming-mail', {
          enabled: true,
          auth: 'google',
          user: 'rechnungen@eingang.example',
          googleServiceAccountKey: '{"type":"authorized_user"}',
        })
      ).statusCode,
    ).toBe(400)
    const saved = await admin.put('/api/v1/settings/incoming-mail', {
      enabled: true,
      auth: 'google',
      user: 'rechnungen@eingang.example',
      googleServiceAccountKey: keyFile,
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({
      auth: 'google',
      googleClientEmail: 'eingang@rechnungen.iam.gserviceaccount.com',
    } satisfies Partial<IncomingMailSettings>)
    expect(saved.body).not.toContain('PRIVATE KEY')
    const [row] = await h.adminSql<{ settings: string }[]>`select settings::text from tenant`
    expect(row?.settings).not.toContain('PRIVATE KEY')
    inbox.messages = []
    const run = (
      await admin.post('/api/v1/settings/incoming-mail/run', {})
    ).json() as IncomingMailRun
    expect(run.error).toBeNull()
    expect(inbox.access).toMatchObject({
      host: 'imap.gmail.com',
      user: 'rechnungen@eingang.example',
      password: null,
      oauth: null,
      google: { clientEmail: 'eingang@rechnungen.iam.gserviceaccount.com' },
    })
    expect(inbox.access?.google?.privateKey).toContain('BEGIN PRIVATE KEY')
    // Kept when saved again without a new key file.
    const kept = await admin.put('/api/v1/settings/incoming-mail', {
      enabled: true,
      auth: 'google',
      user: 'rechnungen@eingang.example',
    })
    expect(kept.json().googleClientEmail).toBe('eingang@rechnungen.iam.gserviceaccount.com')
    await admin.put('/api/v1/settings/incoming-mail', {
      enabled: true,
      host: 'imap.example.test',
      user: 'rechnungen@eingang.example',
      processedMailbox: 'Verarbeitet',
    })
  })

  it('allocates per invoice line, uses the Kreditorennummer and adds project costs', async () => {
    const list = (
      await admin.get('/api/v1/incoming-invoices?status=review')
    ).json() as IncomingInvoiceList
    const id = list.items.find((i) => i.invoiceNumber === 'TS-200')?.id as string
    let detail = await admin.get(`/api/v1/incoming-invoices/${id}`)
    const invoice = detail.json() as IncomingInvoiceDetail
    expect(invoice.contactId).toBe(supplierId)
    expect(invoice.einvoice?.lines.map((l) => [l.id, l.netCents])).toEqual([
      ['1', 75_000],
      ['2', 25_000],
    ])
    const areas = (await admin.get('/api/v1/business-areas')).json() as {
      id: string
      name: string
    }[]
    const lager = areas.find((a) => a.name === 'Lager')?.id
    const patched = await admin.patch(
      `/api/v1/incoming-invoices/${id}`,
      {
        allocations: [
          {
            projectId,
            costType: 'subcontract',
            ratePercent: '19',
            netCents: 75_000,
            lineId: '1',
            description: '1 Trockenbauwände',
          },
          {
            businessAreaId: lager,
            costType: 'material',
            ratePercent: '19',
            netCents: 25_000,
            lineId: '2',
          },
        ],
      },
      { 'if-match': detail.headers.etag as string },
    )
    expect(patched.statusCode, patched.body).toBe(200)
    expect((patched.json() as IncomingInvoiceDetail).allocations.map((a) => a.lineId)).toEqual([
      '1',
      '2',
    ])
    // Kreditorennummer aus dem Nummernkreis beim Bestätigen (Einstellungen › DATEV)
    expect(
      (
        await admin.put('/api/v1/settings/datev', {
          consultantNumber: null,
          clientNumber: null,
          chart: 'SKR03',
          fiscalYearStartMonth: 1,
          accountLength: 4,
          revenueAccounts: {},
          bankAccount: null,
          autoCreditorNumbers: true,
        })
      ).statusCode,
    ).toBe(200)
    expect((await admin.post(`/api/v1/incoming-invoices/${id}/confirm`, {})).statusCode).toBe(200)
    expect((await admin.get(`/api/v1/contacts/${supplierId}`)).json().creditorNumber).toBe('70001')
    detail = await admin.get(`/api/v1/incoming-invoices/${id}`)
    const paid = await admin.post(`/api/v1/incoming-invoices/${id}/payment`, {
      paidOn: '2026-11-07',
    })
    expect(paid.statusCode, paid.body).toBe(200)

    // Filter by Zuweisung and period
    const byProject = (
      await admin.get(
        `/api/v1/incoming-invoices?projectId=${projectId}&from=2026-11-01&to=2026-11-30`,
      )
    ).json() as IncomingInvoiceList
    expect(byProject.items.map((i) => i.invoiceNumber)).toEqual(['TS-200'])
    expect(
      (
        (
          await admin.get(`/api/v1/incoming-invoices?projectId=${projectId}&from=2026-12-01`)
        ).json() as IncomingInvoiceList
      ).items,
    ).toEqual([])

    // Projektkosten
    const figures = (
      await admin.get(`/api/v1/projects/${projectId}/figures`)
    ).json() as ProjectFiguresDto
    expect(figures.costs).toMatchObject({
      totalCents: 75_000,
      byType: { subcontract: 75_000, material: 0 },
      contributionCents: -75_000,
      invoiceCount: 1,
    })

    // Kreditorennummer: unique, used in the DATEV export instead of the Sammelkreditor
    const contact = await admin.get(`/api/v1/contacts/${supplierId}`)
    const updated = await admin.patch(
      `/api/v1/contacts/${supplierId}`,
      { creditorNumber: '70012' },
      { 'if-match': contact.headers.etag as string },
    )
    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json().creditorNumber).toBe('70012')
    const other = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Baustoff Nord',
      creditorNumber: '70012',
    })
    expect(other.statusCode).toBe(400)
    expect(other.json().errors.creditorNumber).toBe('Diese Kreditorennummer ist schon vergeben.')
    expect(
      (
        await admin.post('/api/v1/contacts', {
          kind: 'organization',
          organizationName: 'X',
          creditorNumber: 'K-1',
        })
      ).statusCode,
    ).toBe(400)
    // Vergabe von Hand (Knopf im Kontakt): next free number, only once.
    const nord = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Baustoff Ost',
      })
    ).json() as { id: string }
    const assigned = await admin.post(`/api/v1/contacts/${nord.id}/creditor-number`, {})
    expect(assigned.statusCode, assigned.body).toBe(200)
    expect(assigned.json()).toEqual({ creditorNumber: '70002' })
    expect((await admin.post(`/api/v1/contacts/${nord.id}/creditor-number`, {})).statusCode).toBe(
      409,
    )
    const sequences = (await admin.get('/api/v1/settings/number-sequences')).json() as {
      kind: string
      preview: string
    }[]
    expect(sequences.at(-1)).toMatchObject({ kind: 'creditor', preview: '70003' })
    expect(
      (await admin.patch('/api/v1/settings/number-sequences/creditor', { pattern: 'K-{Nummer}' }))
        .statusCode,
    ).toBe(400)
    await admin.put('/api/v1/settings/datev', {
      consultantNumber: '1234567',
      clientNumber: '10001',
      chart: 'SKR03',
      fiscalYearStartMonth: 1,
      accountLength: 4,
      revenueAccounts: {},
      bankAccount: null,
    })
    const datev = await admin.get('/api/v1/exports/datev?from=2026-11-01&to=2026-11-30')
    expect(datev.statusCode, datev.body).toBe(200)
    const lines = datev.rawPayload.toString('latin1').trim().split('\r\n').slice(2)
    expect(lines).toContain(
      '892,50;"S";"EUR";;;;3100;70012;"9";0311;"TS-200";"";;"Trockenbau Süd GmbH"',
    )
    expect(lines).toContain(
      '1190,00;"S";"EUR";;;;70012;1200;;0711;"TS-200";"";;"Zahlung Trockenbau Süd GmbH"',
    )
  })
})
