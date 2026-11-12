import type { DocumentDetail, ProjectContract, ReportDetail } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Nachträge ausbauen (P2.6): Vertragssumme = Hauptauftrag + beauftragte Nachträge, Nachtrag aus
 * Mehrmengen des Leistungsaufmaßes, Nachweise je Nachtrag.
 */
describe.skipIf(!process.env.DATABASE_URL)('Nachträge und Vertragssumme (integration)', () => {
  let h: Harness
  let admin: Client
  let projectId: string
  let otherProjectId: string
  let units: { id: string; symbol: string }[]
  let contract: DocumentDetail
  let sheetId: string
  let report: ReportDetail
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id

  const create = async (body: Record<string, unknown>, project = projectId) => {
    const res = await admin.post(`/api/v1/projects/${project}/documents`, body)
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as DocumentDetail
  }
  const addItem = async (docId: string, body: Record<string, unknown>) => {
    const res = await admin.post(`/api/v1/documents/${docId}/items`, {
      positionType: 'item',
      ...body,
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as DocumentDetail
  }
  const finalize = async (id: string) => {
    const res = await admin.post(`/api/v1/documents/${id}/finalize`, {})
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as DocumentDetail
  }
  const setStatus = (id: string, status: string) =>
    admin.post(`/api/v1/documents/${id}/status`, { status })
  const contractOf = async () =>
    (await admin.get(`/api/v1/projects/${projectId}/contract`)).json() as ProjectContract

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Nachtrag Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    const customerId = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Wohnbau Nord eG',
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
      })
    ).json().id
    projectId = (await admin.post('/api/v1/projects', { name: 'Lindenweg', customerId })).json().id
    otherProjectId = (await admin.post('/api/v1/projects', { name: 'Anderswo' })).json().id
    units = (await admin.get('/api/v1/units')).json()

    const quote = await create({ type: 'quote' })
    await addItem(quote.id, {
      shortText: 'Wand streichen',
      quantity: '100',
      unitId: unit('m²'),
      unitPriceCents: 1000,
    })
    await addItem(quote.id, {
      shortText: 'Fliesen verlegen',
      quantity: '20',
      unitId: unit('m²'),
      unitPriceCents: 5000,
    })
    await finalize(quote.id)
    contract = await finalize(
      (await create({ type: 'order_confirmation', sourceDocumentId: quote.id })).id,
    )
    sheetId = (
      await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, { kind: 'performance' })
    ).json().id
    report = (
      await admin.post(`/api/v1/projects/${projectId}/reports`, {
        templateKey: 'daily_site_report',
        reportDate: '2026-11-05',
      })
    ).json()
  })

  afterAll(async () => {
    await h?.close()
  })

  it('shows the Vertragssumme without change orders', async () => {
    const result = await contractOf()
    expect(result.contract).toMatchObject({ id: contract.id, netCents: 200_000 })
    expect(result.changeOrders).toEqual([])
    expect(result.totals).toMatchObject({ contractNetCents: 200_000, totalNetCents: 200_000 })
  })

  it('creates a Nachtrag from the Mehrmengen of the Leistungsaufmaß', async () => {
    const wall = contract.items.find((i) => i.shortText === 'Wand streichen')
    const tiles = contract.items.find((i) => i.shortText === 'Fliesen verlegen')
    for (const [itemId, formula] of [
      [wall?.id, '60'],
      [wall?.id, '52,5'],
      [tiles?.id, '18'],
    ]) {
      const res = await admin.post(`/api/v1/measurement-sheets/${sheetId}/lines`, {
        formula,
        documentItemId: itemId,
      })
      expect(res.statusCode, res.body).toBe(201)
    }
    const variances = (await admin.get(`/api/v1/measurement-sheets/${sheetId}/variances`)).json()
    expect(variances).toMatchObject([
      {
        shortText: 'Wand streichen',
        orderedQuantity: '100',
        measuredQuantity: '112.5',
        extraQuantity: '12.5',
      },
    ])

    const res = await admin.post(`/api/v1/measurement-sheets/${sheetId}/change-order`, {})
    expect(res.statusCode, res.body).toBe(201)
    const order = res.json() as DocumentDetail
    expect(order.type).toBe('change_order')
    expect(order.changeOrder).toMatchObject({ number: 1, basis: 'quantity_variance' })
    expect(order.items).toMatchObject([
      {
        shortText: 'Wand streichen',
        quantity: '12.5',
        unitPriceCents: 1000,
        longText: expect.stringContaining('beauftragt 100 m², laut Aufmaß 112,5 m²'),
      },
    ])
    expect(order.changeOrderInfo?.reason).toMatch(/^Mehrmengen laut Aufmaßblatt/)
    expect(order.changeOrderInfo?.evidence).toMatchObject([
      { kind: 'measurement_sheet', id: sheetId, locked: false },
    ])
    // The same Mehrmenge is not claimed twice.
    const again = await admin.post(`/api/v1/measurement-sheets/${sheetId}/change-order`, {})
    expect(again.statusCode).toBe(409)

    // Counted only once accepted.
    let result = await contractOf()
    expect(result.changeOrders).toMatchObject([
      {
        id: order.id,
        changeOrderNumber: 1,
        status: 'draft',
        netCents: 12_500,
        acceptedNetCents: 0,
      },
    ])
    expect(result.totals).toMatchObject({ draftNetCents: 12_500, totalNetCents: 200_000 })
    await finalize(order.id)
    expect((await setStatus(order.id, 'sent')).statusCode).toBe(200)
    result = await contractOf()
    expect(result.totals).toMatchObject({ offeredNetCents: 12_500, potentialNetCents: 212_500 })
    expect((await setStatus(order.id, 'accepted')).statusCode).toBe(200)
    result = await contractOf()
    expect(result.changeOrders[0]).toMatchObject({ status: 'accepted', acceptedNetCents: 12_500 })
    expect(result.totals).toMatchObject({ acceptedNetCents: 12_500, totalNetCents: 212_500 })
  })

  it('keeps Nachweise of the same project with a change order', async () => {
    const order = await create({
      type: 'change_order',
      basis: 'additional_work',
      reason: 'Wasserschaden im Keller',
      evidence: [{ kind: 'report', id: report.id }],
    })
    expect(order.changeOrderInfo?.evidence).toEqual([
      {
        kind: 'report',
        id: report.id,
        label: 'Bautagesbericht vom 05.11.2026',
        date: '2026-11-05',
        locked: false,
      },
    ])
    const foreignSheet = (
      await admin.post(`/api/v1/projects/${otherProjectId}/measurement-sheets`, {
        kind: 'performance',
      })
    ).json().id
    const wrong = await admin.put(`/api/v1/documents/${order.id}/evidence`, {
      evidence: [{ kind: 'measurement_sheet', id: foreignSheet }],
    })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().errors['evidence.0']).toMatch(/nicht zu diesem Projekt/)
    const res = await admin.put(`/api/v1/documents/${order.id}/evidence`, {
      evidence: [
        { kind: 'measurement_sheet', id: sheetId },
        { kind: 'report', id: report.id },
        { kind: 'report', id: report.id },
      ],
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as DocumentDetail).changeOrderInfo?.evidence.map((e) => e.kind)).toEqual([
      'measurement_sheet',
      'report',
    ])
    expect((await contractOf()).changeOrders[1]).toMatchObject({ evidenceCount: 2 })
    // Only change orders have Nachweise.
    expect(
      (await admin.put(`/api/v1/documents/${contract.id}/evidence`, { evidence: [] })).statusCode,
    ).toBe(404)
  })
})
