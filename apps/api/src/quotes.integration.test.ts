import { withTenant } from '@opc/db'
import type { DocumentDetail, UnitSummary } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

describe.skipIf(!process.env.DATABASE_URL)('Angebotserstellung (integration)', () => {
  let h: Harness
  let admin: Client
  let tenantId: string
  let projectId: string
  let customerId: string
  let units: UnitSummary[]
  let quote: DocumentDetail
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id as string
  const item = (doc: DocumentDetail, text: string) =>
    doc.items.find((i) => i.shortText === text) as DocumentDetail['items'][number]
  const create = async (body: Record<string, unknown>) =>
    (await admin.post(`/api/v1/projects/${projectId}/documents`, body)).json() as DocumentDetail
  const addItem = async (doc: DocumentDetail, body: Record<string, unknown>) =>
    (await admin.post(`/api/v1/documents/${doc.id}/items`, body)).json() as DocumentDetail

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: {
        name: 'Maler Muster GmbH',
        street: 'Werkstraße 2',
        postalCode: '30169',
        city: 'Hannover',
      },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    // Einstellungen › Zuschläge: 20 % auf Material.
    await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx`update surcharge set percent = 20 where cost_kind = 'material'`,
    )
    units = (await admin.get('/api/v1/units')).json()
    customerId = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Wohnbau Nord eG',
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
      })
    ).json().id
    projectId = (await admin.post('/api/v1/projects', { name: 'Treppenhaus', customerId })).json()
      .id
    quote = await create({ type: 'quote' })
    quote = await addItem(quote, {
      positionType: 'item',
      shortText: 'Wände streichen',
      quantity: '10',
      unitId: unit('m²'),
      unitPriceCents: 1500,
    })
  })

  afterAll(async () => {
    await h?.close()
  })

  describe('Kalkulation je Position', () => {
    it('calculates EP from labor (minutes at an hourly rate) and material with markup', async () => {
      const wall = item(quote, 'Wände streichen')
      const res = await admin.post(`/api/v1/documents/${quote.id}/items/${wall.id}/calculation`, {
        lines: [
          {
            kind: 'labor',
            description: 'Geselle',
            quantity: '18',
            unitId: unit('min'),
            unitCostCents: 5400,
          },
          {
            kind: 'material',
            description: 'Dispersionsfarbe',
            quantity: '0,3',
            unitId: unit('l'),
            unitCostCents: 800,
          },
        ],
      })
      expect(res.statusCode, res.body).toBe(200)
      quote = res.json()
      // EP = 18 min × 0,90 €/min + 0,3 l × 8,00 € × 1,2 = 16,20 + 2,88 = 19,08 €
      expect(item(quote, 'Wände streichen')).toMatchObject({
        unitPriceCents: 1908,
        totalCents: 19_080,
        calcMode: 'unit_price',
        calculation: {
          costCents: 18_600,
          marginCents: 480,
          marginPercent: '2.52',
          laborHours: '3.00',
        },
      })
      expect(
        item(quote, 'Wände streichen').costLines.map((l) => [
          l.kind,
          l.quantity,
          l.unit?.symbol,
          l.markupPercent,
        ]),
      ).toEqual([
        ['labor', '18', 'min', '0'],
        ['material', '0.3', 'l', '20'],
      ])
      expect(quote.totals).toMatchObject({
        costCents: 18_600,
        marginCents: 480,
        laborHours: '3.00',
        uncalculatedCount: 0,
      })
    })

    it('recalculates with the quantity and ignores typed prices while calculated', async () => {
      const wall = item(quote, 'Wände streichen')
      let res = await admin.patch(`/api/v1/documents/${quote.id}/items/${wall.id}`, {
        quantity: '12',
        unitPriceCents: 1,
      })
      quote = res.json()
      expect(item(quote, 'Wände streichen')).toMatchObject({
        unitPriceCents: 1908,
        totalCents: 22_896,
      })
      expect(quote.totals.laborHours).toBe('3.60')
      // Own markup per line; total price mode: cost lines describe the whole quantity.
      res = await admin.post(`/api/v1/documents/${quote.id}/items/${wall.id}/calculation`, {
        calcMode: 'total_price',
        lines: [
          {
            kind: 'subcontract',
            description: 'Gerüstbauer',
            quantity: '1',
            unitCostCents: 60_000,
            markupPercent: '10',
          },
        ],
      })
      quote = res.json()
      expect(item(quote, 'Wände streichen')).toMatchObject({
        unitPriceCents: 5500,
        totalCents: 66_000,
        calcMode: 'total_price',
      })
    })

    it('validates and can remove the calculation again', async () => {
      const wall = item(quote, 'Wände streichen')
      const url = `/api/v1/documents/${quote.id}/items/${wall.id}/calculation`
      expect(
        (await admin.post(url, { lines: [{ kind: 'labor', quantity: '1', unitCostCents: -5 }] }))
          .statusCode,
      ).toBe(400)
      expect(
        (
          await admin.post(url, {
            lines: [
              {
                kind: 'labor',
                quantity: '1',
                unitCostCents: 5,
                unitId: '0190f4a0-0000-7000-8000-000000000000',
              },
            ],
          })
        ).statusCode,
      ).toBe(400)
      const removed = (await admin.post(url, { lines: [] })).json()
      expect(item(removed, 'Wände streichen')).toMatchObject({
        costLines: [],
        calculation: null,
        unitPriceCents: 5500,
      })
      quote = (
        await admin.post(url, {
          lines: [
            { kind: 'labor', quantity: '18', unitId: unit('min'), unitCostCents: 5400 },
            { kind: 'material', quantity: '0,3', unitId: unit('l'), unitCostCents: 800 },
          ],
        })
      ).json()
      expect(item(quote, 'Wände streichen').unitPriceCents).toBe(1908)
    })
  })

  describe('Fertigstellen', () => {
    it('refuses empty documents, missing recipients and invoices', async () => {
      const empty = await create({ type: 'quote' })
      expect((await admin.post(`/api/v1/documents/${empty.id}/finalize`)).json().detail).toBe(
        'Das Dokument enthält noch keine Positionen.',
      )
      await admin.patch(`/api/v1/documents/${empty.id}`, { contactId: null })
      const noRecipient = await addItem(empty, {
        positionType: 'lump_sum',
        shortText: 'x',
        unitPriceCents: 100,
      })
      expect(
        (await admin.post(`/api/v1/documents/${noRecipient.id}/finalize`)).json().errors,
      ).toEqual({
        contactId: 'Empfänger fehlt.',
      })
      await admin.delete(`/api/v1/documents/${empty.id}`)
      const invoice = await create({ type: 'invoice', invoiceKind: 'standard' })
      expect((await admin.post(`/api/v1/documents/${invoice.id}/finalize`)).statusCode).toBe(409)
      await admin.delete(`/api/v1/documents/${invoice.id}`)
    })

    it('assigns the number, freezes sender and recipient and locks the quote', async () => {
      expect(
        (await admin.patch(`/api/v1/documents/${quote.id}`, { validUntil: '2000-01-01' })).json()
          .errors,
      ).toEqual({
        validUntil: 'Die Bindefrist darf nicht vor dem Datum liegen.',
      })
      await admin.patch(`/api/v1/documents/${quote.id}`, { validUntil: '2099-12-31' })
      const res = await admin.post(`/api/v1/documents/${quote.id}/finalize`)
      expect(res.statusCode, res.body).toBe(200)
      quote = res.json()
      expect(quote).toMatchObject({
        number: 'A-00101',
        status: 'finalized',
        validUntil: '2099-12-31',
        issuer: { name: 'Maler Muster GmbH', lines: ['Werkstraße 2', '30169 Hannover'] },
        recipient: { name: 'Wohnbau Nord eG', lines: ['Lindenweg 4', '30159 Hannover'] },
      })
      expect(quote.finalizedAt).toMatch(/Z$/)
      for (const attempt of [
        await admin.patch(`/api/v1/documents/${quote.id}`, { subject: 'x' }),
        await admin.post(`/api/v1/documents/${quote.id}/items`, {
          positionType: 'title',
          shortText: 'x',
        }),
        await admin.post(`/api/v1/documents/${quote.id}/finalize`),
      ]) {
        expect(attempt.statusCode).toBe(409)
      }
      // Snapshot: a later address change does not alter the quote.
      await admin.patch(`/api/v1/contacts/${customerId}`, {
        addresses: [
          { kind: 'main', street: 'Neue Straße 1', postalCode: '30159', city: 'Hannover' },
        ],
      })
      expect((await admin.get(`/api/v1/documents/${quote.id}`)).json().recipient.lines[0]).toBe(
        'Lindenweg 4',
      )
      const [hash] = await withTenant(
        h.sql,
        { tenantId },
        (tx) =>
          tx<
            { len: number }[]
          >`select length(content_hash) as len from document where id = ${quote.id}`,
      )
      expect(hash?.len).toBe(32)
    })

    it('tracks sent, accepted and rejected', async () => {
      const draft = await create({ type: 'quote' })
      expect(
        (await admin.post(`/api/v1/documents/${draft.id}/status`, { status: 'sent' })).json()
          .detail,
      ).toBe('Bitte das Dokument zuerst fertigstellen.')
      let res = await admin.post(`/api/v1/documents/${quote.id}/status`, { status: 'sent' })
      expect(res.json().status).toBe('sent')
      res = await admin.post(`/api/v1/documents/${quote.id}/status`, { status: 'accepted' })
      expect(res.json().status).toBe('accepted')
      expect(
        (await admin.post(`/api/v1/documents/${quote.id}/status`, { status: 'rejected' }))
          .statusCode,
      ).toBe(409)
    })
  })

  describe('Schalter „Nachtragsangebot“', () => {
    it('needs a main contract', async () => {
      const draft = await create({ type: 'quote' })
      expect(draft.canConvertToChangeOrder).toBe(false)
      const res = await admin.post(`/api/v1/documents/${draft.id}/convert`, { to: 'change_order' })
      expect(res.json().detail).toBe(
        'Ein Nachtrag braucht einen Hauptauftrag (Auftragsbestätigung).',
      )
    })

    it('turns a quote into a change order and back, with N01 numbering', async () => {
      // Hauptauftrag from the accepted quote, completed → AB-00101; the Kalkulation travels along.
      const contract = await create({ type: 'order_confirmation', sourceDocumentId: quote.id })
      expect(item(contract, 'Wände streichen').costLines).toHaveLength(2)
      expect((await admin.post(`/api/v1/documents/${contract.id}/finalize`)).json().number).toBe(
        'AB-00101',
      )

      let offer = await create({ type: 'quote', subject: 'Zusätzliche Fenster' })
      offer = await addItem(offer, {
        positionType: 'item',
        shortText: 'Fensterlaibung',
        quantity: '4',
        unitId: unit('Stk.'),
        unitPriceCents: 4500,
      })
      expect(offer.canConvertToChangeOrder).toBe(true)
      let res = await admin.post(`/api/v1/documents/${offer.id}/convert`, {
        to: 'change_order',
        basis: 'additional_work',
        reason: 'Vom Bauherrn zusätzlich beauftragt',
      })
      offer = res.json()
      expect(offer).toMatchObject({
        type: 'change_order',
        changeOrder: { number: 1, basis: 'additional_work', status: 'draft' },
        changeOrderInfo: {
          contractId: contract.id,
          contractLabel: 'AB-00101',
          reason: 'Vom Bauherrn zusätzlich beauftragt',
        },
      })
      expect(offer.items[0]?.oz).toBe('N01.1')
      res = await admin.post(`/api/v1/documents/${offer.id}/convert`, { to: 'quote' })
      offer = res.json()
      expect(offer).toMatchObject({ type: 'quote', changeOrder: null, changeOrderInfo: null })
      expect(offer.items[0]?.oz).toBe('1')

      offer = (
        await admin.post(`/api/v1/documents/${offer.id}/convert`, { to: 'change_order' })
      ).json()
      offer = (await admin.post(`/api/v1/documents/${offer.id}/finalize`)).json()
      expect(offer.number).toBe('AB-00101/N01')
      expect(
        (await admin.post(`/api/v1/documents/${offer.id}/convert`, { to: 'quote' })).statusCode,
      ).toBe(409)
      offer = (await admin.post(`/api/v1/documents/${offer.id}/status`, { status: 'sent' })).json()
      expect(offer.changeOrder?.status).toBe('offered')
      offer = (
        await admin.post(`/api/v1/documents/${offer.id}/status`, { status: 'accepted' })
      ).json()
      expect(offer.changeOrder?.status).toBe('accepted')
    })
  })
})
