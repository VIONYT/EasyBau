import { withTenant } from '@easybau/db'
import type {
  BusinessArea,
  DocumentDetail,
  IncomingInvoiceDetail,
  IncomingInvoiceList,
} from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Eingangsrechnungen (P1.11): receiving PDF/ZUGFeRD/XRechnung/pictures, review with allocation,
 * "Prüfung bestätigen" (frozen), payment status, Verwerfen/Stornieren, visibility and the rules
 * in the database (never deleted, frozen after confirmation, RLS).
 */
const UBL = (
  number: string,
  net = '1000.00',
  category = 'S',
  rate = '19',
  tax = '190.00',
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
    <cac:PartyName><cbc:Name>Trockenbau Süd GmbH</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Gipsweg 3</cbc:StreetName><cbc:CityName>Hildesheim</cbc:CityName>
      <cbc:PostalZone>31134</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE 123 456 789</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Eingang Bau GmbH</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount><cbc:ID>DE02120300000000202051</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${tax}</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${net}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${tax}</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>${category}</cbc:ID><cbc:Percent>${rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${net}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">${net}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">${(Number(net) + Number(tax)).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">${(Number(net) + Number(tax)).toFixed(2)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="MTK">80</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">${net}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Trockenbauwände</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${category}</cbc:ID><cbc:Percent>${rate}</cbc:Percent>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">12.50</cbc:PriceAmount></cac:Price></cac:InvoiceLine>
</Invoice>`

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('Foto einer Rechnung'),
])

describe.skipIf(!process.env.DATABASE_URL)('Eingangsrechnungen (integration)', () => {
  let h: Harness
  let admin: Client
  let lead: Client
  let worker: Client
  let tenantId: string
  let projectId: string
  let otherProjectId: string
  let areas: BusinessArea[]
  let zugferdPdf: Buffer
  let ownInvoice: DocumentDetail

  const upload = (client: Client, filename: string, data: Buffer) =>
    client.upload(`/api/v1/incoming-invoices?filename=${encodeURIComponent(filename)}`, data)

  async function invite(email: string, roleKey: string, name: string) {
    const invitation = await admin.post('/api/v1/invitations', { email, roleKey })
    const client = new Client(h.app)
    const accepted = await client.post('/api/v1/invitations/accept', {
      token: new URL(invitation.json().acceptUrl).hash.slice(1),
      displayName: name,
      password: `${name.toLowerCase()}-passwort-1`,
    })
    return { client, userId: accepted.json().me.user.id as string }
  }

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Eingang Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
      vatId: 'DE999999999',
      iban: 'DE89370400440532013000',
    })
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Wohnbau Nord eG',
      addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
    })
    projectId = (
      await admin.post('/api/v1/projects', { name: 'Lindenweg', customerId: customer.json().id })
    ).json().id
    otherProjectId = (await admin.post('/api/v1/projects', { name: 'Bahnhofstraße' })).json().id
    areas = (await admin.get('/api/v1/business-areas')).json()

    // A ZUGFeRD PDF as a supplier would send it: the company's own finalized invoice.
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    await admin.patch(`/api/v1/documents/${draft.id}`, {
      contactId: customer.json().id,
      documentDate: '2026-11-02',
      serviceFrom: '2026-10-26',
      paymentDueDays: 14,
    })
    await admin.post(`/api/v1/documents/${draft.id}/items`, {
      positionType: 'item',
      shortText: 'Wände streichen',
      quantity: '80',
      unitId: units.find((u) => u.symbol === 'm²')?.id,
      unitPriceCents: 1250,
    })
    ownInvoice = (await admin.post(`/api/v1/documents/${draft.id}/finalize`, {})).json()
    zugferdPdf = (await admin.get(`/api/v1/documents/${draft.id}/pdf`)).rawPayload

    const projectLead = await invite('pl@example.test', 'project_lead', 'Paula')
    lead = projectLead.client
    await admin.patch(`/api/v1/projects/${projectId}`, { memberIds: [projectLead.userId] })
    worker = (await invite('monteur@example.test', 'team_member', 'Max')).client
  })

  afterAll(async () => {
    await h?.close()
  })

  it('has default business areas and lets admins extend them', async () => {
    expect(areas.map((a) => a.name)).toEqual([
      'Lager',
      'Büro',
      'Mitarbeitende',
      'Fahrzeuge',
      'Werkstatt',
      'Sonstiges',
    ])
    const created = await admin.post('/api/v1/business-areas', { name: 'Gerüstbau' })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ name: 'Gerüstbau', sort: 70, archived: false })
    expect((await admin.post('/api/v1/business-areas', { name: 'Lager' })).statusCode).toBe(409)
    const archived = await admin.patch(`/api/v1/business-areas/${created.json().id}`, {
      archived: true,
    })
    expect(archived.json().archived).toBe(true)
    expect((await lead.post('/api/v1/business-areas', { name: 'X' })).statusCode).toBe(403)
    expect((await worker.get('/api/v1/business-areas')).statusCode).toBe(403)
  })

  let zugferd: IncomingInvoiceDetail

  it('receives a ZUGFeRD PDF, reads the XML, archives the original and prefills the review', async () => {
    const res = await upload(admin, 'Rechnung Maler.pdf', zugferdPdf)
    expect(res.statusCode, res.body).toBe(201)
    zugferd = res.json()
    expect(zugferd).toMatchObject({
      status: 'review',
      source: 'zugferd',
      documentKind: 'invoice',
      filename: 'Rechnung Maler.pdf',
      mimeType: 'application/pdf',
      inline: true,
      supplierName: 'Eingang Bau GmbH',
      supplierVatId: 'DE999999999',
      invoiceNumber: ownInvoice.number,
      invoiceDate: '2026-11-02',
      dueDate: '2026-11-16',
      netCents: 100_000,
      taxCents: 19_000,
      grossCents: 119_000,
      reverseCharge: false,
      taxLines: [{ ratePercent: '19', netCents: 100_000, taxCents: 19_000 }],
      allocations: [],
      einvoiceProfile: 'EN 16931',
      einvoiceEn16931: true,
      einvoiceValid: true,
      uploadedBy: 'Chef',
      archive: { archived: false, retainUntil: '2036-12-31' },
      canEdit: true,
    })
    expect(zugferd.einvoice?.lines[0]).toMatchObject({ name: 'Wände streichen', netCents: 100_000 })
    expect(zugferd.problems.map((p) => p.message)).toEqual([
      'Die Kosten sind noch keinem Projekt oder Betriebsbereich zugewiesen.',
    ])
    expect(res.headers.etag).toBeTruthy()
    // The original is kept unchanged.
    const original = await admin.get(`/api/v1/incoming-invoices/${zugferd.id}/original`)
    expect(original.statusCode).toBe(200)
    expect(original.headers['content-type']).toBe('application/pdf')
    expect(original.headers['content-disposition']).toMatch(/^inline/)
    expect(original.rawPayload.equals(zugferdPdf)).toBe(true)
    const [artifact] = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx`select kind, encode(sha256, 'hex') as sha from document_artifact
                 where incoming_invoice_id = ${zugferd.id}`,
    )
    expect(artifact).toEqual({ kind: 'incoming_original', sha: zugferd.sha256 })
  })

  it('refuses the same file twice and files that are no invoice', async () => {
    const again = await upload(admin, 'nochmal.pdf', zugferdPdf)
    expect(again.statusCode).toBe(409)
    expect(again.json().errors).toEqual({ existingId: zugferd.id })
    expect((await upload(admin, 'liste.txt', Buffer.from('Hallo'))).statusCode).toBe(415)
    expect((await upload(admin, 'falsch.pdf', PNG)).statusCode).toBe(415)
    const order = await upload(admin, 'bestellung.xml', Buffer.from('<Order><ID>1</ID></Order>'))
    expect(order.statusCode).toBe(422)
    expect(order.json().detail).toMatch(/keine E-Rechnung/)
    expect((await upload(admin, 'leer.pdf', Buffer.alloc(0))).statusCode).toBe(400)
    expect((await upload(lead, 'r.xml', Buffer.from(UBL('X-1')))).statusCode).toBe(403)
  })

  it('allocates the costs to a project and a business area and confirms the review', async () => {
    const lager = areas.find((a) => a.name === 'Lager') as BusinessArea
    const stale = await admin.patch(
      `/api/v1/incoming-invoices/${zugferd.id}`,
      { note: 'x' },
      { 'if-match': '"veraltet"' },
    )
    expect(stale.statusCode).toBe(412)
    const current = await admin.get(`/api/v1/incoming-invoices/${zugferd.id}`)
    const wrong = await admin.patch(
      `/api/v1/incoming-invoices/${zugferd.id}`,
      {
        allocations: [
          {
            projectId,
            businessAreaId: lager.id,
            costType: 'material',
            ratePercent: '19',
            netCents: 100_000,
          },
        ],
      },
      { 'if-match': current.headers.etag as string },
    )
    expect(wrong.statusCode).toBe(422)
    const res = await admin.patch(
      `/api/v1/incoming-invoices/${zugferd.id}`,
      {
        note: 'Malerarbeiten Treppenhaus',
        allocations: [
          {
            projectId,
            costType: 'subcontract',
            ratePercent: '19',
            netCents: 80_000,
            description: 'Treppenhaus',
          },
          { businessAreaId: lager.id, costType: 'material', ratePercent: '19,0', netCents: 15_000 },
        ],
      },
      { 'if-match': current.headers.etag as string },
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().problems.map((p: { message: string }) => p.message)).toEqual([
      'Zum Steuersatz 19 % sind noch 50,00 € netto nicht zugewiesen.',
    ])
    expect(
      (await admin.post(`/api/v1/incoming-invoices/${zugferd.id}/confirm`, {})).statusCode,
    ).toBe(422)
    const fixed = await admin.patch(
      `/api/v1/incoming-invoices/${zugferd.id}`,
      {
        allocations: [
          { projectId, costType: 'subcontract', ratePercent: '19', netCents: 85_000 },
          { businessAreaId: lager.id, costType: 'material', ratePercent: '19', netCents: 15_000 },
        ],
      },
      { 'if-match': res.headers.etag as string },
    )
    expect(fixed.json().problems).toEqual([])
    expect(fixed.json().allocations).toMatchObject([
      { projectName: 'Lindenweg', costType: 'subcontract', netCents: 85_000 },
      { businessAreaName: 'Lager', costType: 'material', netCents: 15_000, ratePercent: '19' },
    ])
    const confirmed = await admin.post(`/api/v1/incoming-invoices/${zugferd.id}/confirm`, {})
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json()).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'Chef',
      allocatedTo: ['Lager', 'Lindenweg'],
      problems: [],
    })
    const after = await admin.patch(
      `/api/v1/incoming-invoices/${zugferd.id}`,
      { note: 'später' },
      { 'if-match': confirmed.headers.etag as string },
    )
    expect(after.statusCode).toBe(409)
  })

  it('keeps a confirmed invoice frozen and every invoice undeletable in the database', async () => {
    const run = (
      query: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>,
    ) => withTenant(h.sql, { tenantId }, query)
    await expect(
      run((tx) => tx`update incoming_invoice set gross_cents = 1 where id = ${zugferd.id}`),
    ).rejects.toThrow(/confirmed and cannot be changed/)
    await expect(
      run((tx) => tx`update incoming_invoice set filename = 'x.pdf' where id = ${zugferd.id}`),
    ).rejects.toThrow(/received original/)
    await expect(
      run((tx) => tx`delete from incoming_invoice where id = ${zugferd.id}`),
    ).rejects.toThrow(/permission denied|cannot be deleted/)
    await expect(
      run(
        (tx) =>
          tx`update incoming_invoice_allocation set net_cents = 1 where incoming_invoice_id = ${zugferd.id}`,
      ),
    ).rejects.toThrow(/not in review/)
    await expect(
      run((tx) => tx`delete from incoming_invoice_tax where incoming_invoice_id = ${zugferd.id}`),
    ).rejects.toThrow(/not in review/)
    await expect(
      run((tx) => tx`update incoming_invoice set status = 'review' where id = ${zugferd.id}`),
    ).rejects.toThrow()
    await expect(
      run(
        (tx) =>
          tx`update document_artifact set mime_type = 'x' where incoming_invoice_id = ${zugferd.id}`,
      ),
    ).rejects.toThrow()
  })

  it('sets and resets the payment status and cancels a confirmed invoice', async () => {
    const future = await admin.post(`/api/v1/incoming-invoices/${zugferd.id}/payment`, {
      paidOn: '2026-12-01',
    })
    expect(future.statusCode).toBe(422)
    const paid = await admin.post(`/api/v1/incoming-invoices/${zugferd.id}/payment`, {
      paidOn: '2026-11-07',
      note: 'Sammelüberweisung',
    })
    expect(paid.json()).toMatchObject({ paidOn: '2026-11-07', paymentNote: 'Sammelüberweisung' })
    const list = (
      await admin.get('/api/v1/incoming-invoices?payment=paid')
    ).json() as IncomingInvoiceList
    expect(list.items.map((i) => i.id)).toEqual([zugferd.id])
    const open = await admin.post(`/api/v1/incoming-invoices/${zugferd.id}/payment`, {
      paidOn: null,
    })
    expect(open.json().paidOn).toBeNull()
    h.clock.now = Date.parse('2026-11-20T10:00:00Z')
    const overdue = (await admin.get('/api/v1/incoming-invoices?payment=overdue')).json()
    expect(overdue.items).toMatchObject([{ id: zugferd.id, overdue: true }])
    h.clock.now = Date.parse('2026-11-08T10:00:00Z')
    expect(
      (await admin.post(`/api/v1/incoming-invoices/${zugferd.id}/discard`, { reason: 'x' }))
        .statusCode,
    ).toBe(409)
  })

  let ubl: IncomingInvoiceDetail

  it('reads an XRechnung (UBL), matches the supplier by VAT id and flags § 13b', async () => {
    const supplier = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Trockenbau Süd GmbH',
      vatId: 'DE123456789',
    })
    expect(supplier.statusCode, supplier.body).toBe(201)
    const res = await upload(
      admin,
      'xrechnung.xml',
      Buffer.from(UBL('TS-2026-117', '1000.00', 'AE', '0', '0.00')),
    )
    expect(res.statusCode, res.body).toBe(201)
    ubl = res.json()
    expect(ubl).toMatchObject({
      source: 'xrechnung_ubl',
      inline: false,
      contactId: supplier.json().id,
      supplierName: 'Trockenbau Süd GmbH',
      supplierAddress: 'Gipsweg 3, 31134 Hildesheim',
      supplierIban: 'DE02120300000000202051',
      invoiceNumber: 'TS-2026-117',
      reverseCharge: true,
      netCents: 100_000,
      taxCents: 0,
      grossCents: 100_000,
      taxLines: [{ ratePercent: '0', netCents: 100_000, taxCents: 0 }],
      einvoiceProfile: 'XRechnung 3.0',
    })
    const original = await admin.get(`/api/v1/incoming-invoices/${ubl.id}/original`)
    expect(original.headers['content-disposition']).toMatch(/^attachment/)
    // A second, different file with the same number of the same supplier is a duplicate.
    const twin = await upload(admin, 'xrechnung-kopie.xml', Buffer.from(`${UBL('TS-2026-117')}\n`))
    expect(twin.json().problems.map((p: { message: string }) => p.message)).toContain(
      'Diese Rechnung des Lieferanten ist bereits erfasst (Nr. TS-2026-117, noch in Prüfung).',
    )
    const discarded = await admin.post(`/api/v1/incoming-invoices/${twin.json().id}/discard`, {
      reason: 'Doppelt übermittelt',
    })
    expect(discarded.json()).toMatchObject({
      status: 'discarded',
      closeReason: 'Doppelt übermittelt',
    })
    const later = await admin.patch(
      `/api/v1/incoming-invoices/${twin.json().id}`,
      { note: 'x' },
      { 'if-match': discarded.headers.etag as string },
    )
    expect(later.statusCode).toBe(409)
  })

  it('receives scans and plain PDFs without e-invoice for manual entry', async () => {
    const photo = await upload(admin, 'Tankquittung.png', PNG)
    expect(photo.json()).toMatchObject({
      source: 'image',
      mimeType: 'image/png',
      supplierName: null,
      einvoice: null,
      einvoiceValid: null,
      netCents: 0,
    })
    const pdf = await upload(admin, 'scan.pdf', Buffer.from('%PDF-1.4\n%Scan einer Rechnung\n'))
    expect(pdf.json()).toMatchObject({ source: 'pdf', einvoice: null })
    const done = await admin.patch(
      `/api/v1/incoming-invoices/${pdf.json().id}`,
      {
        supplierName: 'Tankstelle Nord',
        invoiceNumber: 'B-77',
        invoiceDate: '2026-11-04',
        netCents: 5_000,
        taxCents: 950,
        grossCents: 5_950,
        taxLines: [{ ratePercent: '19', netCents: 5_000, taxCents: 950 }],
        allocations: [
          {
            businessAreaId: areas.find((a) => a.name === 'Fahrzeuge')?.id,
            costType: 'other',
            ratePercent: '19',
            netCents: 5_000,
          },
        ],
      },
      { 'if-match': pdf.headers.etag as string },
    )
    expect(done.json().problems).toEqual([])
    const confirmed = await admin.post(`/api/v1/incoming-invoices/${pdf.json().id}/confirm`, {})
    expect(confirmed.json().status).toBe('confirmed')
    const cancelled = await admin.post(`/api/v1/incoming-invoices/${pdf.json().id}/cancel`, {
      reason: 'Privat getankt',
    })
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', closeReason: 'Privat getankt' })
    expect(
      (
        await admin.post(`/api/v1/incoming-invoices/${pdf.json().id}/payment`, {
          paidOn: '2026-11-05',
        })
      ).statusCode,
    ).toBe(409)
  })

  it('lists with filters and a review counter', async () => {
    const all = (await admin.get('/api/v1/incoming-invoices')).json() as IncomingInvoiceList
    expect(all.reviewCount).toBe(2)
    expect(all.items).toHaveLength(5)
    const review = (await admin.get('/api/v1/incoming-invoices?status=review')).json()
    expect(review.items.map((i: { id: string }) => i.id)).toContain(ubl.id)
    const byProject = (await admin.get(`/api/v1/incoming-invoices?projectId=${projectId}`)).json()
    expect(byProject.items.map((i: { id: string }) => i.id)).toEqual([zugferd.id])
    const search = (await admin.get('/api/v1/incoming-invoices?q=Trockenbau')).json()
    expect(search.items).toHaveLength(2)
    const page = (await admin.get('/api/v1/incoming-invoices?limit=2')).json()
    const next = (
      await admin.get(`/api/v1/incoming-invoices?limit=2&cursor=${page.nextCursor}`)
    ).json()
    expect([...page.items, ...next.items].map((i: { id: string }) => i.id)).toEqual(
      all.items.slice(0, 4).map((i) => i.id),
    )
  })

  it('shows project leads only confirmed invoices of their projects, team members nothing', async () => {
    const list = (await lead.get('/api/v1/incoming-invoices')).json() as IncomingInvoiceList
    expect(list.items.map((i) => i.id)).toEqual([zugferd.id])
    expect(list.reviewCount).toBe(0)
    const detail = await lead.get(`/api/v1/incoming-invoices/${zugferd.id}`)
    expect(detail.json().canEdit).toBe(false)
    expect((await lead.get(`/api/v1/incoming-invoices/${ubl.id}`)).statusCode).toBe(404)
    expect((await lead.get(`/api/v1/incoming-invoices/${zugferd.id}/original`)).statusCode).toBe(
      200,
    )
    expect((await worker.get('/api/v1/incoming-invoices')).statusCode).toBe(403)
    // Allocation only to visible projects.
    await admin.patch(`/api/v1/projects/${otherProjectId}`, { memberIds: [] })
    const current = await admin.get(`/api/v1/incoming-invoices/${ubl.id}`)
    const res = await lead.patch(
      `/api/v1/incoming-invoices/${ubl.id}`,
      { note: 'x' },
      { 'if-match': current.headers.etag as string },
    )
    expect(res.statusCode).toBe(403)
  })

  it('keeps incoming invoices of other companies invisible (RLS)', async () => {
    const [other] = await h.adminSql<{ id: string }[]>`
      insert into tenant (name) values ('Fremdfirma GmbH') returning id`
    const seen = await withTenant(
      h.sql,
      { tenantId: (other as { id: string }).id },
      (tx) => tx`select
        (select count(*)::int from incoming_invoice) as invoices,
        (select count(*)::int from incoming_invoice_allocation) as allocations,
        (select count(*)::int from incoming_invoice_tax) as taxes,
        (select count(*)::int from business_area) as areas`,
    )
    expect(seen[0]).toEqual({ invoices: 0, allocations: 0, taxes: 0, areas: 0 })
  })
})
