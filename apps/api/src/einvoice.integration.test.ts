import { withTenant } from '@opc/db'
import type { DocumentDetail, FinalizeCheck } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type EinvoiceValidator, kositValidator, ValidatorUnavailableError } from './kosit.js'
import {
  acceptingValidator,
  Client,
  createHarness,
  type Harness,
  rejectingValidator,
} from './testing/harness.js'

/**
 * E-Rechnung (rule 8, ADR 0007): Festschreiben builds ZUGFeRD (+ XRechnung), KoSIT checks every
 * file, XML and report are archived, the PDF/A-3 carries factur-x.xml. With KOSIT_URL set (Docker
 * pipeline) the real validator is used; the failure paths use stubs.
 */
describe.skipIf(!process.env.DATABASE_URL)('E-Rechnung (integration)', () => {
  let h: Harness
  let admin: Client
  let tenantId: string
  let projectId: string
  let customerId: string
  let authorityId: string
  // Switchable validator: default from the harness (real KoSIT or accepting stub).
  let current: EinvoiceValidator | null = null
  let fallback: EinvoiceValidator
  const switchable: EinvoiceValidator = {
    validate: (xml) => (current ?? fallback).validate(xml),
  }
  let units: { id: string; symbol: string }[]
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id as string

  const draftInvoice = async (contactId: string) => {
    const res = await admin.post(`/api/v1/projects/${projectId}/documents`, {
      type: 'invoice',
      invoiceKind: 'standard',
    })
    expect(res.statusCode, res.body).toBe(201)
    const doc = res.json() as DocumentDetail
    const patched = await admin.patch(`/api/v1/documents/${doc.id}`, {
      contactId,
      documentDate: '2026-11-20',
      serviceFrom: '2026-11-02',
      serviceTo: '2026-11-13',
      paymentDueDays: 14,
    })
    expect(patched.statusCode, patched.body).toBe(200)
    for (const item of [
      { shortText: 'Wände streichen', quantity: '86,5', unitId: unit('m²'), unitPriceCents: 1250 },
      { shortText: 'Regiestunden', quantity: '6', unitId: unit('Std'), unitPriceCents: 5800 },
    ]) {
      const added = await admin.post(`/api/v1/documents/${doc.id}/items`, {
        positionType: 'item',
        ...item,
      })
      expect(added.statusCode, added.body).toBe(201)
    }
    return doc.id
  }

  beforeAll(async () => {
    // Same default as the harness: real KoSIT with KOSIT_URL, otherwise the accepting stub.
    fallback = process.env.KOSIT_URL
      ? kositValidator(process.env.KOSIT_URL, 60_000)
      : acceptingValidator
    h = await createHarness({ requireAdminMfa: false, einvoiceValidator: switchable })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'E-Rechnung Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    const company = await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      vatId: 'DE123456789',
      taxNumber: '25/123/45678',
      email: 'buero@ebau.example',
      phone: '0511 123456',
      managerName: 'Erika Meister',
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
    })
    expect(company.statusCode, company.body).toBe(200)
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Wohnbau Nord eG',
      assignCustomerNumber: true,
      addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
    })
    expect(customer.statusCode, customer.body).toBe(201)
    customerId = customer.json().id
    const authority = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Stadt Hannover, Fachbereich Gebäude',
      assignCustomerNumber: true,
      buyerReference: '03241000-12345-67',
      addresses: [{ kind: 'main', street: 'Trammplatz 2', postalCode: '30159', city: 'Hannover' }],
    })
    expect(authority.statusCode, authority.body).toBe(201)
    authorityId = authority.json().id
    const project = await admin.post('/api/v1/projects', { name: 'Schule Lindenweg', customerId })
    projectId = project.json().id
    units = (await admin.get('/api/v1/units')).json()
  })

  afterAll(async () => {
    await h?.close()
  })

  let invoice: DocumentDetail

  it('issues ZUGFeRD at Festschreiben and archives XML and KoSIT report', async () => {
    const id = await draftInvoice(customerId)
    const res = await admin.post(`/api/v1/documents/${id}/finalize`, {})
    expect(res.statusCode, res.body).toBe(200)
    invoice = res.json()
    expect(invoice.recipient).toMatchObject({
      address: { street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover', countryCode: 'DE' },
      customerNumber: expect.stringMatching(/^K/),
    })
    expect(invoice.issuer.einvoice).toMatchObject({
      iban: 'DE89370400440532013000',
      vatId: 'DE123456789',
    })
    expect(invoice.einvoice?.files).toEqual([
      {
        format: 'zugferd',
        validatedAt: expect.stringMatching(/Z$/),
        sizeBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ])

    const xml = await admin.get(`/api/v1/documents/${id}/einvoice/zugferd`)
    expect(xml.statusCode).toBe(200)
    expect(xml.headers['content-disposition']).toBe(
      `attachment; filename="${invoice.number}_zugferd.xml"`,
    )
    expect(xml.body).toContain('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>')
    expect(xml.body).toContain(`<ram:ID>${invoice.number}</ram:ID>`)
    expect(xml.body).toContain('<ram:BilledQuantity unitCode="MTK">86.5</ram:BilledQuantity>')
    const report = await admin.get(`/api/v1/documents/${id}/einvoice/zugferd/report`)
    expect(report.statusCode).toBe(200)
    expect(report.body).toContain('<rep:accept')
    expect((await admin.get(`/api/v1/documents/${id}/einvoice/xrechnung_ubl`)).statusCode).toBe(404)

    // The PDF/A-3 carries the archived XML as factur-x.xml and the Factur-X XMP.
    const pdf = await admin.get(`/api/v1/documents/${id}/pdf`)
    expect(pdf.statusCode).toBe(200)
    const bytes = pdf.rawPayload.toString('latin1')
    expect(bytes).toContain('/F (factur-x.xml)')
    expect(bytes).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>')
    const artifacts = await withTenant(
      h.sql,
      { tenantId },
      (tx) =>
        tx<{ kind: string; format: string | null; validated: boolean }[]>`
        select kind, format, validated_at is not null as validated from document_artifact
        where document_id = ${id}
        order by array_position(array['zugferd_xml', 'validation_report', 'zugferd_pdf'], kind)`,
    )
    expect(artifacts).toEqual([
      { kind: 'zugferd_xml', format: 'zugferd', validated: true },
      { kind: 'validation_report', format: 'zugferd', validated: false },
      { kind: 'zugferd_pdf', format: 'zugferd', validated: true },
    ])
  })

  it('adds XRechnung (UBL) for a customer with Leitweg-ID', async () => {
    const id = await draftInvoice(authorityId)
    const res = await admin.post(`/api/v1/documents/${id}/finalize`, {})
    expect(res.statusCode, res.body).toBe(200)
    const doc = res.json() as DocumentDetail
    expect(doc.einvoice?.files.map((f) => f.format)).toEqual(['zugferd', 'xrechnung_ubl'])
    const xml = await admin.get(`/api/v1/documents/${id}/einvoice/xrechnung_ubl`)
    expect(xml.body).toContain('<cbc:BuyerReference>03241000-12345-67</cbc:BuyerReference>')
    expect(xml.headers['content-disposition']).toContain('_xrechnung.xml')
  })

  it('a Stornorechnung is an e-invoice with reference to the cancelled invoice', async () => {
    const res = await admin.post(`/api/v1/documents/${invoice.id}/cancel`, {
      reason: 'Falscher Leistungszeitraum',
    })
    expect(res.statusCode, res.body).toBe(201)
    const cancellationId = res.json().cancellation.id
    const xml = await admin.get(`/api/v1/documents/${cancellationId}/einvoice/zugferd`)
    expect(xml.statusCode).toBe(200)
    expect(xml.body).toContain('<ram:TypeCode>384</ram:TypeCode>')
    expect(xml.body).toContain(`<ram:IssuerAssignedID>${invoice.number}</ram:IssuerAssignedID>`)
  })

  it('does not finalize when KoSIT rejects the file: no number is consumed', async () => {
    const id = await draftInvoice(customerId)
    const preview = (
      (await admin.get(`/api/v1/documents/${id}/finalize-check`)).json() as FinalizeCheck
    ).numberPreview
    current = rejectingValidator
    const rejected = await admin.post(`/api/v1/documents/${id}/finalize`, {})
    expect(rejected.statusCode).toBe(422)
    expect(rejected.json()).toMatchObject({
      detail: expect.stringMatching(/hat die Prüfung nicht bestanden/),
      errors: { einvoice: 'BR-DE-15: Buyer reference fehlt.' },
    })
    expect((await admin.get(`/api/v1/documents/${id}`)).json()).toMatchObject({
      status: 'draft',
      number: null,
    })

    current = {
      validate: async () => {
        throw new ValidatorUnavailableError('connection refused')
      },
    }
    const down = await admin.post(`/api/v1/documents/${id}/finalize`, {})
    expect(down.statusCode).toBe(503)
    expect(down.json().detail).toMatch(/gerade nicht erreichbar/)

    current = null
    const ok = await admin.post(`/api/v1/documents/${id}/finalize`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().number).toBe(preview)
  })

  it('names missing e-invoice data in the finalize check', async () => {
    const xr = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Landesamt ohne Adresse',
      einvoiceFormat: 'xrechnung_ubl',
      addresses: [{ kind: 'main', street: 'Postfach 1' }],
    })
    expect(xr.statusCode, xr.body).toBe(201)
    const id = await draftInvoice(xr.json().id)
    const result = (
      await admin.get(`/api/v1/documents/${id}/finalize-check`)
    ).json() as FinalizeCheck
    expect(result.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/PLZ und Ort des Empfängers fehlen/),
      expect.stringMatching(/Leitweg-ID oder E-Mail-Adresse für E-Rechnungen/),
    ])
  })

  it('keeps rule 8 in the database: no e-invoice without validation', async () => {
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) =>
          tx`insert into document_artifact (tenant_id, document_id, kind, format, storage_key, sha256,
                                          size_bytes, mime_type, locked_until)
           values (${tenantId}, ${invoice.id}, 'xrechnung_xml', 'xrechnung_ubl', 'x', ${Buffer.alloc(32)},
                   1, 'application/xml', '2037-12-31')`,
      ),
    ).rejects.toThrow(/document_artifact_einvoice_validated/)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('E-Rechnung ohne Prüfdienst (integration)', () => {
  let h: Harness

  afterAll(async () => {
    await h?.close()
  })

  it('refuses to finalize invoices without KoSIT', async () => {
    h = await createHarness({ requireAdminMfa: false, einvoiceValidator: null })
    const admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Ohne Prüfung GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
    })
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Kunde',
      addresses: [{ kind: 'main', street: 'Weg 1', postalCode: '30159', city: 'Hannover' }],
    })
    const project = await admin.post('/api/v1/projects', { name: 'P' })
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const doc = (
      await admin.post(`/api/v1/projects/${project.json().id}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json()
    await admin.patch(`/api/v1/documents/${doc.id}`, {
      contactId: customer.json().id,
      serviceFrom: '2026-11-02',
    })
    await admin.post(`/api/v1/documents/${doc.id}/items`, {
      positionType: 'item',
      shortText: 'Arbeit',
      quantity: '1',
      unitId: units.find((u) => u.symbol === 'Std')?.id,
      unitPriceCents: 5000,
    })
    const res = await admin.post(`/api/v1/documents/${doc.id}/finalize`, {})
    expect(res.statusCode).toBe(503)
    expect(res.json().detail).toMatch(/nicht eingerichtet/)
    const status = (await admin.get('/api/v1/settings/operations')).json()
    expect(status.einvoice).toEqual({ configured: false, reachable: false })
  })
})
