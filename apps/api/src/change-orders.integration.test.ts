import type { DocumentDetail, ProjectContract, ReportDetail } from '@easybau/schemas'
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
        // VOB/B § 2 Abs. 3 Nr. 2: more than 110 % – a new price may be agreed.
        measuredPercent: '113',
        deviation: 'over_110',
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
    // Above 110 % of the LV quantity: a new price may be agreed (shown, not applied).
    expect(order.changeOrderInfo?.priceReview).toEqual([
      {
        itemId: order.items[0]?.id,
        oz: order.items[0]?.oz,
        shortText: 'Wand streichen',
        percent: '113',
      },
    ])
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

  it('bills the Mehrmenge only via the beauftragten Nachtrag, not again via the Aufmaß', async () => {
    const invoice = await create({
      type: 'invoice',
      invoiceKind: 'standard',
      sourceDocumentId: contract.id,
    })
    const applied = await admin.post(`/api/v1/documents/${invoice.id}/apply-measurements`)
    expect(applied.statusCode, applied.body).toBe(200)
    const doc = applied.json() as DocumentDetail
    const wall = doc.items.find((i) => i.shortText === 'Wand streichen')
    // Measured 112,5 m², LV 100 m², 12,5 m² in the beauftragten Nachtrag N01.
    expect(wall).toMatchObject({ quantity: '100', cumulativeQuantity: '100' })
    expect(doc.items.find((i) => i.shortText === 'Fliesen verlegen')?.quantity).toBe('18')
    const checkOf = async () =>
      (await admin.get(`/api/v1/documents/${invoice.id}/finalize-check`)).json() as {
        errors: { message: string }[]
      }
    expect(JSON.stringify((await checkOf()).errors)).not.toContain('Mehrmengen-Nachtrag')
    // Typed in by hand: the Mehrmenge would be on two invoices.
    const typed = await admin.patch(`/api/v1/documents/${invoice.id}/items/${wall?.id}`, {
      quantity: '112.5',
    })
    expect(typed.statusCode, typed.body).toBe(200)
    expect(JSON.stringify((await checkOf()).errors)).toContain(
      'Abgerechnet wären 112,5, laut Aufmaß stehen der Position aber nur 100 zu – 12,5 sind bereits im beauftragten Mehrmengen-Nachtrag',
    )
    await admin.delete(`/api/v1/documents/${invoice.id}`)
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

  it('accepts a change order in part (Teilbeauftragung)', async () => {
    const order = await create({ type: 'change_order', basis: 'additional_work' })
    await addItem(order.id, {
      shortText: 'Steckdosen',
      quantity: '4',
      unitId: unit('m²'),
      unitPriceCents: 5000,
    })
    const withBoth = await addItem(order.id, {
      shortText: 'Leuchten',
      quantity: '2',
      unitId: unit('m²'),
      unitPriceCents: 10_000,
    })
    const [sockets, lights] = withBoth.items.filter((i) => i.positionType === 'item')
    await finalize(order.id)
    const before = (await contractOf()).totals.acceptedNetCents
    // All positions → please use „beauftragt“; foreign ids are refused.
    expect(
      (
        await admin.post(`/api/v1/documents/${order.id}/status`, {
          status: 'partially_accepted',
          acceptedItemIds: [sockets?.id, lights?.id],
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (
        await admin.post(`/api/v1/documents/${order.id}/status`, {
          status: 'partially_accepted',
          acceptedItemIds: [contract.items[0]?.id],
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (await admin.post(`/api/v1/documents/${order.id}/status`, { status: 'partially_accepted' }))
        .statusCode,
    ).toBe(400)
    const res = await admin.post(`/api/v1/documents/${order.id}/status`, {
      status: 'partially_accepted',
      acceptedItemIds: [sockets?.id],
    })
    expect(res.statusCode, res.body).toBe(200)
    const decided = res.json() as DocumentDetail
    expect(decided.status).toBe('partially_accepted')
    expect(decided.changeOrderInfo?.acceptedItemIds).toEqual([sockets?.id])
    const result = await contractOf()
    expect(result.changeOrders.find((c) => c.id === order.id)).toMatchObject({
      status: 'partially_accepted',
      netCents: 40_000,
      acceptedNetCents: 20_000,
    })
    expect(result.totals.acceptedNetCents).toBe(before + 20_000)
    // Decided: no further change.
    expect(
      (await admin.post(`/api/v1/documents/${order.id}/status`, { status: 'accepted' })).statusCode,
    ).toBe(409)
  })
})
