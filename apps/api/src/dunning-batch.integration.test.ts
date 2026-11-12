import type { DocumentDetail, DunningBatchResult, InvoiceList } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Mahnvorschläge (P2.2): the invoice list shows the last and the next Mahnstufe, filters the
 * invoices whose next notice can be issued today, and a Mahnlauf issues them in one go.
 */
describe.skipIf(!process.env.DATABASE_URL)('Mahnvorschläge und Mahnlauf (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let projectId: string
  let customerId: string
  let units: { id: string; symbol: string }[]
  const at = (iso: string) => {
    h.clock.now = Date.parse(`${iso}T10:00:00Z`)
  }

  async function invoice(documentDate: string) {
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    await admin.patch(`/api/v1/documents/${draft.id}`, {
      contactId: customerId,
      documentDate,
      serviceFrom: documentDate,
      paymentDueDays: 14,
    })
    await admin.post(`/api/v1/documents/${draft.id}/items`, {
      positionType: 'item',
      shortText: 'Wände streichen',
      quantity: '80',
      unitId: units.find((u) => u.symbol === 'm²')?.id,
      unitPriceCents: 1250,
    })
    const res = await admin.post(`/api/v1/documents/${draft.id}/finalize`, {})
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as DocumentDetail
  }
  const list = async (query = '') =>
    (await admin.get(`/api/v1/invoices${query}`)).json() as InvoiceList

  let overdue: DocumentDetail
  let fresh: DocumentDetail
  let paid: DocumentDetail

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false, smtp: true })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Mahnlauf Bau GmbH' },
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
      iban: 'DE89370400440532013000',
    })
    customerId = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Wohnbau Nord eG',
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
        channels: [{ kind: 'email', value: 'buchhaltung@wohnbau.example', isPrimary: true }],
      })
    ).json().id
    projectId = (await admin.post('/api/v1/projects', { name: 'Lindenweg', customerId })).json().id
    units = (await admin.get('/api/v1/units')).json()
    at('2026-11-02')
    overdue = await invoice('2026-11-02')
    paid = await invoice('2026-11-02')
    await admin.post(`/api/v1/documents/${paid.id}/payments`, {
      paidOn: '2026-11-02',
      amountCents: 119_000,
    })
    at('2026-11-15')
    fresh = await invoice('2026-11-15')
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
    at('2026-11-20')
  })

  afterAll(async () => {
    await h?.close()
  })

  it('shows the next Mahnstufe in the invoice list and filters the due ones', async () => {
    const all = await list()
    const byId = (id: string) => all.items.find((i) => i.id === id)
    expect(byId(overdue.id)).toMatchObject({
      dunningLevel: null,
      nextDunning: { level: 'reminder', possibleFrom: '2026-11-17', due: true },
    })
    expect(byId(fresh.id)).toMatchObject({
      nextDunning: { level: 'reminder', possibleFrom: '2026-11-30', due: false },
    })
    expect(byId(paid.id)?.nextDunning).toBeNull()
    const due = await list('?dunning=due')
    expect(due.items.map((i) => i.number)).toEqual([overdue.number])
    expect(due.sums.count).toBe(1)
    const csv = (await admin.get('/api/v1/invoices/export.csv?dunning=due')).body
    expect(csv).toContain('Nächste Mahnstufe ab')
    expect(csv).toContain('Zahlungserinnerung ab 17.11.2026')
  })

  it('issues the next notice for each selected invoice and reports the ones that are not due', async () => {
    expect(
      (await worker.post('/api/v1/dunning/batch', { invoiceIds: [overdue.id] })).statusCode,
    ).toBe(403)
    expect((await admin.post('/api/v1/dunning/batch', { invoiceIds: [] })).statusCode).toBe(400)
    const res = await admin.post('/api/v1/dunning/batch', {
      invoiceIds: [overdue.id, fresh.id, paid.id, overdue.id],
    })
    expect(res.statusCode, res.body).toBe(200)
    const results = res.json().results as DunningBatchResult[]
    expect(results).toMatchObject([
      {
        invoiceId: overdue.id,
        number: overdue.number,
        ok: true,
        level: 'reminder',
        emailedTo: 'buchhaltung@wohnbau.example',
        error: null,
      },
      {
        invoiceId: fresh.id,
        ok: false,
        level: null,
        error: 'Die Rechnung ist erst am 29.11.2026 fällig.',
      },
      { invoiceId: paid.id, ok: false, error: 'Die Rechnung ist vollständig bezahlt.' },
    ])
    const dunning = (await admin.get(`/api/v1/documents/${overdue.id}/dunning`)).json()
    expect(dunning.notices).toHaveLength(1)
    expect(dunning.notices[0]).toMatchObject({
      level: 'reminder',
      email: { to: 'buchhaltung@wohnbau.example', status: 'queued' },
    })
    // Afterwards: angemahnt, next level only after the deadline of the reminder.
    const after = (await list()).items.find((i) => i.id === overdue.id)
    expect(after).toMatchObject({
      status: 'dunned',
      dunningLevel: 'reminder',
      nextDunning: { level: 'first', due: false },
    })
    expect((await list('?dunning=due')).items).toEqual([])
  })

  it('issues PDF-only notices when e-mail is not wanted', async () => {
    at('2026-12-15')
    const res = await admin.post('/api/v1/dunning/batch', {
      invoiceIds: [overdue.id, fresh.id],
      email: false,
    })
    expect(res.json().results).toMatchObject([
      { invoiceId: overdue.id, ok: true, level: 'first', emailedTo: null },
      { invoiceId: fresh.id, ok: true, level: 'reminder', emailedTo: null },
    ])
  })
})
