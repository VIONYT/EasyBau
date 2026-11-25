import type { DocumentDetail, Page, ProjectFiguresDto, ProjectSummary } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Projektkennzahlen und Listenfilter (P2.7): Soll-Stunden aus der Kalkulation, Auftragssumme,
 * abgerechnet, bezahlt, offen; Projektliste nach Zeitraum, Status und Mitarbeitenden.
 */
describe.skipIf(!process.env.DATABASE_URL)('Projektkennzahlen (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let projectId: string
  let customerId: string
  let units: { id: string; symbol: string }[]
  const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id
  const at = (iso: string) => {
    h.clock.now = Date.parse(`${iso}T10:00:00Z`)
  }

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
  const finalize = async (id: string) => {
    const res = await admin.post(`/api/v1/documents/${id}/finalize`, { acknowledgeWarnings: true })
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as DocumentDetail
  }
  const figures = async () => {
    const res = await admin.get(`/api/v1/projects/${projectId}/figures`)
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as ProjectFiguresDto
  }

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Kennzahl Bau GmbH' },
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
    customerId = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Wohnbau Nord eG',
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
      })
    ).json().id
    projectId = (
      await admin.post('/api/v1/projects', {
        name: 'Lindenweg',
        customerId,
        startDate: '2026-10-01',
        endDate: '2026-12-15',
      })
    ).json().id
    units = (await admin.get('/api/v1/units')).json()
    const invite = await admin.post('/api/v1/invitations', {
      email: 'monteur@example.test',
      roleKey: 'team_member',
    })
    worker = new Client(h.app)
    await worker.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Monteur',
      password: 'monteur-passwort-1',
    })
    at('2026-11-02')
  })

  afterAll(async () => {
    await h?.close()
  })

  it('takes the Soll-Stunden from the quote until there is a contract', async () => {
    expect((await figures()).hoursBasis).toBeNull()
    const quote = await create({ type: 'quote' })
    let doc = await addItem(quote.id, {
      shortText: 'Wände streichen',
      quantity: '100',
      unitId: unit('m²'),
    })
    const wall = doc.items.find((i) => i.shortText === 'Wände streichen')
    const calc = await admin.post(`/api/v1/documents/${quote.id}/items/${wall?.id}/calculation`, {
      lines: [
        {
          kind: 'labor',
          description: 'Geselle',
          quantity: '12',
          unitId: unit('min'),
          unitCostCents: 4800,
        },
      ],
    })
    expect(calc.statusCode, calc.body).toBe(200)
    doc = await addItem(quote.id, {
      shortText: 'Baustelleneinrichtung',
      quantity: '1',
      unitId: unit('psch'),
      unitPriceCents: 50_000,
    })
    expect(await figures()).toMatchObject({
      plannedHours: '20',
      hoursBasis: { kind: 'quote' },
      uncalculatedCount: 1,
      contractNetCents: null,
      unbilledNetCents: null,
    })
    await finalize(quote.id)
    const ab = await finalize(
      (await create({ type: 'order_confirmation', sourceDocumentId: quote.id })).id,
    )
    // EP = 12 min × 0,80 €/min = 9,60 € → 100 m² = 960 € + 500 € Pauschale
    expect(await figures()).toMatchObject({
      plannedHours: '20',
      hoursBasis: { kind: 'contract', label: ab.number },
      contractNetCents: 146_000,
      billedNetCents: 0,
      unbilledNetCents: 146_000,
      billedPercent: '0.0',
      invoiceCount: 0,
    })
  })

  it('counts billed, paid and open amounts; a Storno cancels out', async () => {
    const contractId = (await admin.get(`/api/v1/projects/${projectId}/contract`)).json().contract
      .id
    const invoice = async () => {
      const doc = await create({
        type: 'invoice',
        invoiceKind: 'progress',
        sourceDocumentId: contractId,
      })
      await admin.patch(`/api/v1/documents/${doc.id}`, {
        documentDate: '2026-11-02',
        serviceFrom: '2026-11-02',
        paymentDueDays: 14,
      })
      return finalize(doc.id)
    }
    const first = await invoice()
    expect(first.totals.netCents).toBe(146_000)
    await admin.post(`/api/v1/documents/${first.id}/payments`, {
      paidOn: '2026-11-02',
      amountCents: 100_000,
    })
    let result = await figures()
    expect(result).toMatchObject({
      billedNetCents: 146_000,
      billedGrossCents: 173_740,
      paidCents: 100_000,
      openReceivableCents: 73_740,
      unbilledNetCents: 0,
      billedPercent: '100.0',
      invoiceCount: 1,
    })
    // An invoice and its Stornorechnung are both left out.
    const second = await invoice()
    expect(second.totals.netCents).toBe(0)
    const cancel = await admin.post(`/api/v1/documents/${second.id}/cancel`, { reason: 'Doppelt' })
    expect(cancel.statusCode, cancel.body).toBe(201)
    result = await figures()
    expect(result).toMatchObject({ billedNetCents: 146_000, invoiceCount: 1 })

    // Monteure see no money.
    expect((await worker.get(`/api/v1/projects/${projectId}/figures`)).statusCode).toBe(403)
  })

  it('filters the project list by Zeitraum', async () => {
    await admin.post('/api/v1/projects', {
      name: 'Frühjahr',
      startDate: '2026-03-01',
      endDate: '2026-04-30',
    })
    await admin.post('/api/v1/projects', { name: 'Ohne Termin' })
    await admin.post('/api/v1/projects', { name: 'Ab Dezember', startDate: '2026-12-01' })
    const names = async (query: string) =>
      ((await admin.get(`/api/v1/projects?${query}`)).json() as Page<ProjectSummary>).items
        .map((p) => p.name)
        .sort()
    expect(await names('')).toEqual(['Ab Dezember', 'Frühjahr', 'Lindenweg', 'Ohne Termin'])
    expect(await names('from=2026-11-01&to=2026-11-30')).toEqual(['Lindenweg'])
    expect(await names('from=2026-12-10')).toEqual(['Ab Dezember', 'Lindenweg'])
    expect(await names('to=2026-05-01')).toEqual(['Frühjahr'])
    // Without end date the project runs on; without start date it ran from the beginning.
    expect((await admin.get('/api/v1/projects?from=2026-13-01')).statusCode).toBe(400)
    // Filter Mitarbeitende: the team list has names only.
    const team = (await worker.get('/api/v1/team')).json() as { id: string; displayName: string }[]
    expect(team.map((p) => p.displayName)).toEqual(['Chef', 'Monteur'])
    expect(Object.keys(team[0] ?? {})).toEqual(['id', 'displayName'])
    const monteur = team.find((p) => p.displayName === 'Monteur')?.id
    await admin.patch(`/api/v1/projects/${projectId}`, { memberIds: [monteur] })
    expect(await names(`memberId=${monteur}&from=2026-11-01`)).toEqual(['Lindenweg'])
  })
})
