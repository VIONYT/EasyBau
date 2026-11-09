import { withTenant } from '@opc/db'
import type { DocumentDetail, FinalizeCheck } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Rechnungen festschreiben (DESIGN.md §4.1): Angebot → Auftrag → Leistungsaufmaß →
 * 1. Abschlag (kumuliert) → 2. Abschlag (einzeln) → Schlussrechnung mit Abzug der Abschläge.
 */
describe.skipIf(!process.env.DATABASE_URL)('Rechnungen (integration)', () => {
  let h: Harness
  let admin: Client
  let tenantId: string
  let projectId: string
  let contract: DocumentDetail
  let sheetId: string
  let units: { id: string; symbol: string }[]
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id as string
  const itemOf = (doc: DocumentDetail, text: string) =>
    doc.items.find((i) => i.shortText === text) as DocumentDetail['items'][number]

  const create = async (body: Record<string, unknown>) => {
    const res = await admin.post(`/api/v1/projects/${projectId}/documents`, body)
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
  const finalize = (id: string, body: Record<string, unknown> = {}) =>
    admin.post(`/api/v1/documents/${id}/finalize`, body)
  const measure = async (itemId: string, formula: string) => {
    const res = await admin.post(`/api/v1/measurement-sheets/${sheetId}/lines`, {
      formula,
      documentItemId: itemId,
    })
    expect(res.statusCode, res.body).toBe(201)
  }
  const applyMeasurements = async (id: string) => {
    const res = await admin.post(`/api/v1/documents/${id}/apply-measurements`)
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as DocumentDetail
  }
  const check = async (id: string) =>
    (await admin.get(`/api/v1/documents/${id}/finalize-check`)).json() as FinalizeCheck

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Rechnung Bau GmbH' },
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
      assignCustomerNumber: true,
      addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
    })
    expect(customer.statusCode, customer.body).toBe(201)
    const project = await admin.post('/api/v1/projects', {
      name: 'Sanierung Lindenweg',
      customerId: customer.json().id,
    })
    projectId = project.json().id
    units = (await admin.get('/api/v1/units')).json()

    // Angebot → Auftragsbestätigung (Hauptauftrag).
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
    expect((await finalize(quote.id)).statusCode).toBe(200)
    const ab = await create({ type: 'order_confirmation', sourceDocumentId: quote.id })
    expect((await finalize(ab.id)).statusCode).toBe(200)
    contract = (await admin.get(`/api/v1/documents/${ab.id}`)).json()

    const sheet = await admin.post(`/api/v1/projects/${projectId}/measurement-sheets`, {
      kind: 'performance',
    })
    sheetId = sheet.json().id
  })

  afterAll(async () => {
    await h?.close()
  })

  let progress1: DocumentDetail

  it('checks the mandatory invoice data (§ 14 Abs. 4 UStG) before finalizing', async () => {
    progress1 = await create({
      type: 'invoice',
      invoiceKind: 'progress',
      sourceDocumentId: contract.id,
    })
    const result = await check(progress1.id)
    expect(result.errors.map((e) => e.message)).toEqual([
      'Name und vollständige Anschrift Ihrer Firma fehlen (Einstellungen › Firma).',
      'Steuernummer oder USt-IdNr. Ihrer Firma fehlt (Einstellungen › Firma).',
      'Leistungsdatum oder Leistungszeitraum fehlt.',
    ])
    expect(result.numberPreview).toBe('R-00101')
    const res = await finalize(progress1.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().errors.serviceFrom).toBe('Leistungsdatum oder Leistungszeitraum fehlt.')
    // The preview did not consume a number.
    expect((await check(progress1.id)).numberPreview).toBe('R-00101')

    await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
    })
    const patched = await admin.patch(`/api/v1/documents/${progress1.id}`, {
      documentDate: '2026-10-31',
      serviceFrom: '2026-10-01',
      serviceTo: '2026-10-31',
      paymentDueDays: 14,
      cashDiscountPercent: '2',
      cashDiscountDays: 7,
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect((await check(progress1.id)).errors).toEqual([])
  })

  it('bills the Leistungsaufmaß and finalizes the 1. Abschlagsrechnung', async () => {
    await measure(itemOf(contract, 'Wand streichen').id, '40')
    await measure(itemOf(contract, 'Fliesen verlegen').id, '5')
    let doc = await applyMeasurements(progress1.id)
    expect(
      doc.items.map((i) => [
        i.shortText,
        i.quantity,
        i.cumulativeQuantity,
        i.previouslyBilledQuantity,
      ]),
    ).toEqual([
      ['Wand streichen', '40', '40', '0'],
      ['Fliesen verlegen', '5', '5', '0'],
    ])
    expect(doc.totals).toMatchObject({ netCents: 65_000, taxCents: 12_350, grossCents: 77_350 })
    expect(doc.legalNotes).toContain('1. Abschlagsrechnung nach erbrachtem Leistungsstand.')

    const res = await finalize(progress1.id)
    expect(res.statusCode, res.body).toBe(200)
    doc = res.json()
    expect(doc).toMatchObject({
      status: 'finalized',
      number: 'R-00101',
      dueDate: '2026-11-14',
      recipient: {
        name: 'Wohnbau Nord eG',
        lines: ['Lindenweg 4', '30159 Hannover'],
        private: false,
      },
    })
    expect(doc.legalNotes).toEqual([
      '1. Abschlagsrechnung nach erbrachtem Leistungsstand.',
      'Bei Zahlung bis 07.11.2026 gewähren wir 2 % Skonto (15,47 €). Ohne Abzug zahlbar bis 14.11.2026.',
    ])
    // Rule 12: the measurement lines behind the invoice are locked.
    const sheet = (await admin.get(`/api/v1/measurement-sheets/${sheetId}`)).json()
    expect(sheet.lines.every((l: { locked: boolean }) => l.locked)).toBe(true)
    const line = sheet.lines[0] as { id: string }
    expect(
      (
        await admin.patch(`/api/v1/measurement-sheets/${sheetId}/lines/${line.id}`, {
          formula: '1',
        })
      ).statusCode,
    ).toBe(409)
    // Immutable afterwards.
    expect(
      (await admin.patch(`/api/v1/documents/${progress1.id}`, { subject: 'x' })).statusCode,
    ).toBe(409)
  })

  let progress2: DocumentDetail

  it('bills only the increment in the individual mode and detects outdated quantities', async () => {
    await measure(itemOf(contract, 'Wand streichen').id, '30')
    progress2 = await create({
      type: 'invoice',
      invoiceKind: 'progress',
      sourceDocumentId: progress1.id,
    })
    await admin.patch(`/api/v1/documents/${progress2.id}`, {
      progressBillingMode: 'individual',
      serviceFrom: '2026-11-01',
      serviceTo: '2026-11-15',
      documentDate: '2026-11-16',
    })
    let doc = await applyMeasurements(progress2.id)
    expect(
      doc.items.map((i) => [i.quantity, i.cumulativeQuantity, i.previouslyBilledQuantity]),
    ).toEqual([
      ['30', '70', '40'],
      ['0', '5', '5'],
    ])
    expect(doc.totals.deductions).toEqual([])
    // New lines after taking over the quantities: finalizing is refused until they are updated.
    await measure(itemOf(contract, 'Wand streichen').id, '10')
    const refused = await finalize(progress2.id)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().errors.items).toMatch(/Leistungsaufmaß haben sich geändert/)
    doc = await applyMeasurements(progress2.id)
    expect(doc.items[0]?.quantity).toBe('40')
    const res = await finalize(progress2.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      number: 'R-00102',
      totals: { netCents: 40_000, taxCents: 7_600 },
    })
  })

  it('deducts all progress invoices in the Schlussrechnung and warns about free positions', async () => {
    const final = await create({
      type: 'invoice',
      invoiceKind: 'final',
      sourceDocumentId: contract.id,
    })
    await admin.patch(`/api/v1/documents/${final.id}`, {
      serviceFrom: '2026-10-01',
      serviceTo: '2026-11-20',
      documentDate: '2026-11-21',
      retentionPercent: '5',
    })
    await applyMeasurements(final.id)
    // A free position (not part of the contract): allowed only with a warning (rule 12).
    await addItem(final.id, {
      shortText: 'Zusätzliche Reinigung',
      quantity: '1',
      unitId: unit('Stk.'),
      unitPriceCents: 2000,
    })
    const doc = (await admin.get(`/api/v1/documents/${final.id}`)).json() as DocumentDetail
    expect(doc.items.map((i) => [i.quantity, i.previouslyBilledQuantity])).toEqual([
      ['80', '80'],
      ['5', '5'],
      ['1', null],
    ])
    expect(doc.totals).toMatchObject({
      performance: {
        netCents: 107_000,
        taxCents: 380 + 12_350 + 7_600,
        grossCents: 107_000 + 20_330,
      },
      deductions: [
        {
          number: 'R-00101',
          progressNo: 1,
          netCents: 65_000,
          taxCents: 12_350,
          grossCents: 77_350,
        },
        { number: 'R-00102', progressNo: 2, netCents: 40_000, taxCents: 7_600, grossCents: 47_600 },
      ],
      netCents: 2_000,
      taxCents: 380,
      grossCents: 2_380,
      retentionCents: 119,
      payableCents: 2_261,
    })
    expect(doc.legalNotes[0]).toMatch(/abschließend abgerechnet/)

    const warned = await finalize(final.id)
    expect(warned.statusCode).toBe(409)
    expect(warned.json().errors.items).toMatch(
      /„Zusätzliche Reinigung“ gehört weder zum Hauptauftrag/,
    )
    const res = await finalize(final.id, { acknowledgeWarnings: true })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({
      number: 'R-00103',
      invoiceKind: 'final',
      status: 'finalized',
    })
    const [rows] = await withTenant(
      h.sql,
      { tenantId },
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from document_deduction where document_id = ${final.id}`,
    )
    expect(rows?.n).toBe(2)
  })

  it('refuses positions of change orders that are not accepted', async () => {
    const changeOrder = await create({ type: 'change_order', basis: 'additional_work' })
    await addItem(changeOrder.id, {
      shortText: 'Zusätzliche Steckdosen',
      quantity: '3',
      unitId: unit('Stk.'),
      unitPriceCents: 4500,
    })
    const invoice = await create({
      type: 'invoice',
      invoiceKind: 'standard',
      sourceDocumentId: changeOrder.id,
    })
    await admin.patch(`/api/v1/documents/${invoice.id}`, { serviceFrom: '2026-11-20' })
    const res = await finalize(invoice.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().errors.items).toMatch(/stammt aus Nachtrag N01, der nicht beauftragt ist/)
  })

  it('needs the permission to finalize invoices', async () => {
    const invite = await admin.post('/api/v1/invitations', {
      email: 'bauleitung@example.test',
      roleKey: 'project_lead',
    })
    const lead = new Client(h.app)
    const accepted = await lead.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Bauleitung',
      password: 'bauleitung-pass-1',
    })
    expect(accepted.statusCode).toBe(200)
    // Member of the project: may edit documents, but not finalize invoices.
    const members = await admin.patch(`/api/v1/projects/${projectId}`, {
      memberIds: [accepted.json().me.user.id],
    })
    expect(members.statusCode, members.body).toBe(200)
    const invoice = await create({ type: 'invoice', invoiceKind: 'standard' })
    const res = await lead.post(`/api/v1/documents/${invoice.id}/finalize`)
    expect(res.statusCode).toBe(403)
    expect(res.json().detail).toMatch(/Berechtigung/)
  })
})
