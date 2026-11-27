import type { DocumentDetail } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acceptingValidator, Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Security audit run-1: a final invoice finalized while a progress invoice of the same project is
 * still being finalized (its transaction open during the KoSIT call) must deduct it.
 */
describe.skipIf(!process.env.DATABASE_URL)('Festschreiben im selben Projekt (integration)', () => {
  let h: Harness
  let admin: Client
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const enteredA = new Promise<void>((resolve) => {
    entered = resolve
  })

  beforeAll(async () => {
    h = await createHarness({
      requireAdminMfa: false,
      einvoiceValidator: {
        async validate(xml: string) {
          if (xml.includes('GATE-A')) {
            entered()
            await gate
          }
          return acceptingValidator.validate(xml)
        },
      },
    })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Gleichzeitig Bau GmbH' },
      admin: { email: 'chef@example.test', password: 'ein-sehr-langes-passwort', displayName: 'C' },
    })
    await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
    })
  })

  afterAll(async () => {
    await h?.close()
  })

  it('deducts a progress invoice finalized at the same time', async () => {
    const customer = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Kunde eG',
        assignCustomerNumber: true,
        addresses: [{ kind: 'main', street: 'Weg 4', postalCode: '30159', city: 'Hannover' }],
      })
    ).json()
    const projectId = (
      await admin.post('/api/v1/projects', { name: 'Parallel', customerId: customer.id })
    ).json().id
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const m2 = units.find((u) => u.symbol === 'm²')?.id as string
    const create = async (body: Record<string, unknown>) =>
      (await admin.post(`/api/v1/projects/${projectId}/documents`, body)).json() as DocumentDetail
    const quote = await create({ type: 'quote' })
    await admin.post(`/api/v1/documents/${quote.id}/items`, {
      positionType: 'item',
      shortText: 'Wand streichen',
      quantity: '100',
      unitId: m2,
      unitPriceCents: 1000,
    })
    await admin.post(`/api/v1/documents/${quote.id}/finalize`, {})
    const ab = await create({ type: 'order_confirmation', sourceDocumentId: quote.id })
    await admin.post(`/api/v1/documents/${ab.id}/finalize`, {})
    const contract = (await admin.get(`/api/v1/documents/${ab.id}`)).json() as DocumentDetail
    const sheet = (
      await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, { kind: 'performance' })
    ).json()
    await admin.post(`/api/v1/measurement-sheets/${sheet.id}/lines`, {
      formula: '40',
      documentItemId: contract.items[0]?.id,
    })
    const a = await create({
      type: 'invoice',
      invoiceKind: 'progress',
      sourceDocumentId: contract.id,
    })
    await admin.patch(`/api/v1/documents/${a.id}`, {
      subject: 'GATE-A',
      documentDate: '2026-11-01',
      serviceFrom: '2026-10-01',
      serviceTo: '2026-10-31',
    })
    await admin.post(`/api/v1/documents/${a.id}/apply-measurements`)
    const b = await create({ type: 'invoice', invoiceKind: 'final', sourceDocumentId: contract.id })
    await admin.patch(`/api/v1/documents/${b.id}`, {
      documentDate: '2026-11-02',
      serviceFrom: '2026-10-01',
      serviceTo: '2026-11-01',
    })
    await admin.post(`/api/v1/documents/${b.id}/apply-measurements`)

    const finalizeA = admin.post(`/api/v1/documents/${a.id}/finalize`, {})
    await enteredA
    const finalizeB = admin.post(`/api/v1/documents/${b.id}/finalize`, {
      acknowledgeWarnings: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    release()
    const [resA, resB] = await Promise.all([finalizeA, finalizeB])
    expect(resA.statusCode, resA.body).toBe(200)
    expect(resB.statusCode, resB.body).toBe(200)

    const docA = (await admin.get(`/api/v1/documents/${a.id}`)).json() as DocumentDetail
    const docB = (await admin.get(`/api/v1/documents/${b.id}`)).json() as DocumentDetail
    expect(docA.totals.netCents).toBe(40000)
    expect(docB.totals.deductions.map((d) => d.number)).toEqual([docA.number])
    expect(docB.totals.netCents).toBe(0)
  })
})
