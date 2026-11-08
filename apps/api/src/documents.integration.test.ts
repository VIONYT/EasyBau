import { withTenant } from '@opc/db'
import type { DocumentDetail, DocumentOption, UnitSummary } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

describe.skipIf(!process.env.DATABASE_URL)('project documents (integration)', () => {
  let h: Harness
  let admin: Client
  let tenantId: string
  let projectId: string
  let customerId: string
  let units: UnitSummary[]
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id as string
  const docsUrl = () => `/api/v1/projects/${projectId}/documents`
  const options = async () =>
    (await admin.get(`/api/v1/projects/${projectId}/document-options`)).json() as DocumentOption[]
  const option = (list: DocumentOption[], type: string, invoiceKind: string | null = null) =>
    list.find((o) => o.type === type && o.invoiceKind === invoiceKind) as DocumentOption
  const create = async (body: Record<string, unknown>) => {
    const res = await admin.post(docsUrl(), body)
    return { status: res.statusCode, doc: res.json() as DocumentDetail, res }
  }
  const addItem = async (docId: string, body: Record<string, unknown>) => {
    const res = await admin.post(`/api/v1/documents/${docId}/items`, body)
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as DocumentDetail
  }

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Beleg Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Wohnbau Nord eG',
    })
    customerId = customer.json().id
    const project = await admin.post('/api/v1/projects', {
      name: 'Sanierung Lindenweg',
      customerId,
      startDate: '2026-11-02',
      endDate: '2026-12-18',
      site: { street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' },
    })
    projectId = project.json().id
    units = (await admin.get('/api/v1/units')).json()
  })

  afterAll(async () => {
    await h?.close()
  })

  it('lists units and tax rates for the position editor', async () => {
    expect(units.map((u) => u.symbol)).toEqual(
      expect.arrayContaining(['Stk.', 'm²', 'psch', 'Std']),
    )
    const rates = (await admin.get('/api/v1/tax-rates')).json()
    expect(rates[0]).toMatchObject({ percent: '19', isDefault: true, categoryCode: 'S' })
  })

  it('offers the document types that make sense for the project', async () => {
    const list = await options()
    expect(option(list, 'quote').available).toBe(true)
    expect(option(list, 'change_order')).toMatchObject({
      available: false,
      reason: 'Ein Nachtrag braucht einen Hauptauftrag (Auftragsbestätigung).',
    })
    expect(option(list, 'invoice', 'final').available).toBe(false)
    expect(option(list, 'invoice', 'progress').progressNo).toBe(1)
  })

  describe('Angebot mit Positionen', () => {
    let quote: DocumentDetail

    it('creates a draft with customer, place of performance and without number', async () => {
      const { status, doc } = await create({ type: 'quote' })
      expect(status).toBe(201)
      quote = doc
      expect(doc).toMatchObject({
        type: 'quote',
        invoiceKind: null,
        status: 'draft',
        number: null,
        subject: 'Sanierung Lindenweg',
        contact: { id: customerId, displayName: 'Wohnbau Nord eG' },
        placeOfPerformance: 'Lindenweg 4, 30159 Hannover',
        taxMode: 'standard',
        paymentDueDays: null,
        serviceFrom: null,
        items: [],
        createdBy: { displayName: 'Chef' },
        project: { id: projectId, name: 'Sanierung Lindenweg' },
      })
      expect(doc.totals).toMatchObject({ netCents: 0, taxCents: 0, grossCents: 0 })
      expect(doc.documentDate).toMatch(/^\d{4}-\d\d-\d\d$/)
    })

    it('builds the outline with numbering (OZ) and calculates totals on the server', async () => {
      let doc = await addItem(quote.id, { positionType: 'title', shortText: 'Malerarbeiten' })
      const title = doc.items[0]?.id as string
      doc = await addItem(quote.id, {
        positionType: 'item',
        parentId: title,
        shortText: 'Wandfläche streichen',
        longText: 'Dispersionsfarbe, zweimal',
        quantity: '12,5',
        unitId: unit('m²'),
        unitPriceCents: 4500,
      })
      doc = await addItem(quote.id, {
        positionType: 'optional',
        parentId: title,
        shortText: 'Zusätzlicher Anstrich (Bedarf)',
        quantity: 1,
        unitId: unit('Stk.'),
        unitPriceCents: 99_900,
      })
      doc = await addItem(quote.id, {
        positionType: 'text',
        parentId: title,
        longText: 'Hinweis: Möbel bauseits',
      })
      doc = await addItem(quote.id, {
        positionType: 'lump_sum',
        shortText: 'Baustelleneinrichtung',
        unitPriceCents: 25_000,
      })
      doc = await addItem(quote.id, {
        positionType: 'item',
        shortText: 'Fachbuch',
        quantity: '2',
        unitId: unit('Stk.'),
        unitPriceCents: 1990,
        taxRatePercent: '7',
      })
      expect(doc.items.map((i) => [i.oz, i.level, i.positionType])).toEqual([
        ['1', 0, 'title'],
        ['1.1', 1, 'item'],
        ['1.2', 1, 'optional'],
        [null, 1, 'text'],
        ['2', 0, 'lump_sum'],
        ['3', 0, 'item'],
      ])
      expect(doc.items[1]).toMatchObject({
        quantity: '12.5',
        unit: { symbol: 'm²' },
        unitPriceCents: 4500,
        totalCents: 56_250,
        taxRatePercent: '19',
      })
      expect(doc.items[4]).toMatchObject({
        quantity: '1',
        unit: { symbol: 'psch' },
        totalCents: 25_000,
      })
      // Optional positions are printed but not summed.
      expect(doc.totals).toEqual({
        itemsNetCents: 85_230,
        discountCents: 0,
        netCents: 85_230,
        taxCents: 15_717,
        grossCents: 100_947,
        taxLines: [
          {
            category: 'S',
            ratePercent: '19.00',
            netCents: 81_250,
            taxCents: 15_438,
            exemptionReason: null,
          },
          {
            category: 'S',
            ratePercent: '7.00',
            netCents: 3980,
            taxCents: 279,
            exemptionReason: null,
          },
        ],
        titleSubtotals: { [title]: 56_250 },
      })
      expect(doc.netTotalCents).toBe(85_230)
      quote = doc
    })

    it('validates positions', async () => {
      const url = `/api/v1/documents/${quote.id}/items`
      const missing = await admin.post(url, { positionType: 'item', shortText: 'x' })
      expect(missing.json().errors).toEqual({ quantity: 'Menge fehlt.', unitId: 'Einheit fehlt.' })
      const bad = await admin.post(url, {
        positionType: 'item',
        shortText: 'x',
        quantity: '1,234',
        unitId: unit('m'),
      })
      expect(bad.json().errors.quantity).toMatch(/höchstens 2 Nachkommastellen/)
      const unknownUnit = await admin.post(url, {
        positionType: 'item',
        shortText: 'x',
        quantity: '1',
        unitId: '0190f4a0-0000-7000-8000-000000000000',
      })
      expect(unknownUnit.json().errors).toEqual({ unitId: 'Unbekannte Einheit.' })
      const underItem = await admin.post(url, {
        positionType: 'item',
        parentId: quote.items[1]?.id,
        shortText: 'x',
        quantity: '1',
        unitId: unit('m'),
      })
      expect(underItem.statusCode).toBe(400)
      const sub = await addItem(quote.id, {
        positionType: 'title',
        parentId: quote.items[0]?.id,
        shortText: 'Untertitel',
      })
      const subId = sub.items.find((i) => i.shortText === 'Untertitel')?.id
      expect(sub.items.find((i) => i.id === subId)?.oz).toBe('1.3')
      const tooDeep = await admin.post(url, {
        positionType: 'title',
        parentId: subId,
        shortText: 'x',
      })
      expect(tooDeep.json().detail).toMatch(/höchstens zwei Ebenen/)
      quote = (await admin.delete(`${url}/${subId}`)).json()
    })

    it('updates, moves and removes positions with recalculation', async () => {
      const position = quote.items[1]?.id as string
      let res = await admin.patch(`/api/v1/documents/${quote.id}/items/${position}`, {
        quantity: '10',
        discountPercent: '10',
      })
      expect(res.json().items[1]).toMatchObject({
        quantity: '10',
        discountPercent: '10',
        totalCents: 40_500,
      })
      expect(
        (await admin.patch(`/api/v1/documents/${quote.id}/items/${position}`, { quantity: null }))
          .statusCode,
      ).toBe(400)
      res = await admin.post(`/api/v1/documents/${quote.id}/items/${position}/move`, {
        direction: 'down',
      })
      const moved: DocumentDetail = res.json()
      expect(moved.items.slice(1, 3).map((i) => [i.oz, i.positionType])).toEqual([
        ['1.1', 'optional'],
        ['1.2', 'item'],
      ])
      res = await admin.post(`/api/v1/documents/${quote.id}/items/${position}/move`, {
        direction: 'up',
      })
      expect(res.json().items[1].id).toBe(position)
      // Removing a title removes its positions.
      const temp = await addItem(quote.id, { positionType: 'title', shortText: 'Entfällt' })
      const tempId = temp.items.find((i) => i.shortText === 'Entfällt')?.id as string
      await addItem(quote.id, {
        positionType: 'item',
        parentId: tempId,
        shortText: 'weg',
        quantity: '1',
        unitId: unit('Stk.'),
        unitPriceCents: 100,
      })
      res = await admin.delete(`/api/v1/documents/${quote.id}/items/${tempId}`)
      quote = res.json()
      expect(quote.items.some((i) => i.shortText === 'weg')).toBe(false)
      expect(quote.totals.netCents).toBe(40_500 + 25_000 + 3980)
    })

    it('edits the header with optimistic locking and document discount', async () => {
      const current = await admin.get(`/api/v1/documents/${quote.id}`)
      const etag = current.headers.etag as string
      const res = await admin.request(
        'PATCH',
        `/api/v1/documents/${quote.id}`,
        {
          subject: 'Angebot Malerarbeiten',
          discountPercent: '5',
          introText: 'Sehr geehrte Damen und Herren,',
        },
        { 'if-match': etag },
      )
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ subject: 'Angebot Malerarbeiten', discountPercent: '5' })
      expect(res.json().totals.discountCents).toBe(3474)
      const stale = await admin.request(
        'PATCH',
        `/api/v1/documents/${quote.id}`,
        { subject: 'x' },
        { 'if-match': etag },
      )
      expect(stale.statusCode).toBe(412)
      const reverse = await admin.patch(`/api/v1/documents/${quote.id}`, {
        taxMode: 'reverse_charge_13b',
      })
      expect(reverse.json().totals.taxLines).toEqual([
        expect.objectContaining({
          category: 'AE',
          taxCents: 0,
          exemptionReason: 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG).',
        }),
      ])
      await admin.patch(`/api/v1/documents/${quote.id}`, {
        taxMode: 'standard',
        discountPercent: null,
      })
    })

    it('derives an order confirmation from the quote (Zusammenhängend erstellen)', async () => {
      quote = (await admin.get(`/api/v1/documents/${quote.id}`)).json()
      const { status, doc } = await create({
        type: 'order_confirmation',
        sourceDocumentId: quote.id,
      })
      expect(status).toBe(201)
      expect(doc).toMatchObject({
        sourceDocumentId: quote.id,
        subject: 'Angebot Malerarbeiten',
        introText: 'Sehr geehrte Damen und Herren,',
      })
      expect(doc.items.map((i) => [i.oz, i.shortText, i.totalCents])).toEqual(
        quote.items.map((i) => [i.oz, i.shortText, i.totalCents]),
      )
      expect(doc.totals).toEqual({
        ...quote.totals,
        titleSubtotals: Object.fromEntries(
          Object.values(quote.totals.titleSubtotals).map((v) => [doc.items[0]?.id, v]),
        ),
      })
      const source = await withTenant(
        h.sql,
        { tenantId },
        (tx) =>
          tx<
            { n: number }[]
          >`select count(*)::int as n from document_item where document_id = ${doc.id} and source_item_id is not null`,
      )
      expect(source[0]?.n).toBe(quote.items.length)
      const foreign = await create({
        type: 'quote',
        sourceDocumentId: '0190f4a0-0000-7000-8000-000000000000',
      })
      expect(foreign.status).toBe(400)
    })

    it('does not delete documents that others were created from', async () => {
      const res = await admin.delete(`/api/v1/documents/${quote.id}`)
      expect(res.statusCode).toBe(409)
    })
  })

  describe('Nachträge und Rechnungen', () => {
    it('numbers change orders per main contract', async () => {
      expect(option(await options(), 'change_order').available).toBe(true)
      const first = await create({
        type: 'change_order',
        basis: 'changed_work',
        reason: 'Putzschäden',
      })
      expect(first.status).toBe(201)
      expect(first.doc.changeOrder).toEqual({ number: 1, basis: 'changed_work', status: 'draft' })
      const second = await create({ type: 'change_order' })
      expect(second.doc.changeOrder).toEqual({
        number: 2,
        basis: 'additional_work',
        status: 'draft',
      })
    })

    it('numbers progress invoices and allows one final invoice', async () => {
      const p1 = await create({ type: 'invoice', invoiceKind: 'progress' })
      const p2 = await create({ type: 'invoice', invoiceKind: 'progress' })
      expect([p1.doc.progressNo, p2.doc.progressNo]).toEqual([1, 2])
      // Billing defaults: payment term of the company, service period from the project.
      expect(p1.doc).toMatchObject({
        paymentDueDays: 7,
        serviceFrom: '2026-11-02',
        serviceTo: '2026-12-18',
      })
      expect(option(await options(), 'invoice', 'progress').progressNo).toBe(3)
      const final = await create({ type: 'invoice', invoiceKind: 'final' })
      expect(final.status).toBe(201)
      const again = await create({ type: 'invoice', invoiceKind: 'final' })
      expect(again.status).toBe(409)
      expect(again.res.json().detail).toBe(
        'Für dieses Projekt gibt es bereits eine Schlussrechnung.',
      )
      expect((await admin.delete(`/api/v1/documents/${p2.doc.id}`)).statusCode).toBe(204)
    })

    it('validates the document type', async () => {
      expect((await create({ type: 'invoice' })).res.json().errors).toEqual({
        invoiceKind: 'Rechnungsart fehlt.',
      })
      expect((await create({ type: 'quote', invoiceKind: 'final' })).status).toBe(400)
      expect((await create({ type: 'brief' })).status).toBe(400)
    })

    it('lists documents grouped by type', async () => {
      const list = (await admin.get(docsUrl())).json()
      expect(list.map((d: DocumentDetail) => [d.type, d.invoiceKind, d.progressNo])).toEqual([
        ['quote', null, null],
        ['order_confirmation', null, null],
        ['change_order', null, null],
        ['change_order', null, null],
        ['invoice', 'progress', 1],
        ['invoice', 'final', null],
      ])
    })
  })

  it('keeps finalized documents immutable (rule 2)', async () => {
    const { doc } = await create({ type: 'invoice', invoiceKind: 'standard' })
    await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx`
      update document set status = 'finalized', finalized_at = now(), number = 'R-00101',
             content_hash = sha256('x'::bytea), recipient_snapshot = '{}', issuer_snapshot = '{}'
      where id = ${doc.id}`,
    )
    const url = `/api/v1/documents/${doc.id}`
    for (const res of [
      await admin.patch(url, { subject: 'geändert' }),
      await admin.post(`${url}/items`, { positionType: 'title', shortText: 'x' }),
      await admin.delete(url),
    ]) {
      expect(res.statusCode).toBe(409)
      expect(res.json().detail).toMatch(/Festgeschriebene Dokumente/)
    }
  })

  it('requires document permissions and project visibility', async () => {
    const invite = await admin.post('/api/v1/invitations', {
      email: 'bau@example.test',
      roleKey: 'team_member',
    })
    const worker = new Client(h.app)
    await worker.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Bauarbeiter',
      password: 'bauarbeiter-pass-1',
    })
    expect((await worker.get(docsUrl())).statusCode).toBe(403)
    expect((await worker.post(docsUrl(), { type: 'quote' })).statusCode).toBe(403)
    const archived = await admin.post(`/api/v1/projects/${projectId}/archive`)
    expect(archived.statusCode).toBe(204)
    expect((await create({ type: 'quote' })).status).toBe(409)
  })
})
