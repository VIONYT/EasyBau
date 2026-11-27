import type { CatalogItem, ContactDetail, DocumentDetail } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Security audit run-1: purchase costs and margins only with price.view (DESIGN.md §5.2), and
 * contact-derived lists only with the projects the person may see.
 */
describe.skipIf(!process.env.DATABASE_URL)('Preise und Projektsichtbarkeit (integration)', () => {
  let h: Harness
  let admin: Client
  let teamLead: Client
  let auditor: Client
  let projectLead: Client
  let itemId: string
  let quoteId: string
  let positionId: string
  let customerId: string

  async function join(roleKey: string, email: string, accessUntil?: string) {
    const invitation = await admin.post('/api/v1/invitations', { email, roleKey, accessUntil })
    expect(invitation.statusCode, invitation.body).toBe(201)
    const client = new Client(h.app)
    const accepted = await client.post('/api/v1/invitations/accept', {
      token: new URL(invitation.json().acceptUrl).hash.slice(1),
      displayName: roleKey,
      password: 'ein-langes-passwort-1',
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    return client
  }

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Sichtbar Bau GmbH' },
      admin: { email: 'chef@example.test', password: 'ein-sehr-langes-passwort', displayName: 'C' },
    })
    teamLead = await join('team_lead', 'team@example.test')
    auditor = await join('auditor', 'pruefer@example.test', '2026-12-31')
    projectLead = await join('project_lead', 'pl@example.test')
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const unit = (symbol: string) => units.find((u) => u.symbol === symbol)?.id
    itemId = (
      await admin.post('/api/v1/catalog/items', {
        kind: 'material',
        shortText: 'Tiefengrund',
        unitId: unit('l'),
        costCents: 777,
        markupPercent: '40',
      })
    ).json().id
    customerId = (
      await admin.post('/api/v1/contacts', { kind: 'organization', organizationName: 'Kunde eG' })
    ).json().id
    const projectId = (
      await admin.post('/api/v1/projects', { name: 'Geheimes Projekt', customerId })
    ).json().id
    const quote = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'quote',
        subject: 'Geheimer Betreff',
      })
    ).json() as DocumentDetail
    quoteId = quote.id
    const withItem = (
      await admin.post(`/api/v1/documents/${quoteId}/items`, {
        positionType: 'item',
        shortText: 'Wand',
        quantity: '2',
        unitId: unit('m²'),
        unitPriceCents: 5000,
      })
    ).json() as DocumentDetail
    positionId = withItem.items.find((i) => i.shortText === 'Wand')?.id as string
    const calc = await admin.post(`/api/v1/documents/${quoteId}/items/${positionId}/calculation`, {
      lines: [
        {
          kind: 'labor',
          description: 'Lohn',
          quantity: '30',
          unitId: unit('min'),
          unitCostCents: 3300,
          markupPercent: '15',
        },
      ],
    })
    expect(calc.statusCode, calc.body).toBe(200)
  })

  afterAll(async () => {
    await h?.close()
  })

  it('leaves purchase costs out of the catalog without price.view', async () => {
    const own = (await admin.get(`/api/v1/catalog/items/${itemId}`)).json() as CatalogItem
    expect(own).toMatchObject({ costCents: 777, markupPercent: '40' })
    const detail = (await teamLead.get(`/api/v1/catalog/items/${itemId}`)).json() as CatalogItem
    expect(detail).toMatchObject({ costCents: null, markupPercent: null, components: [] })
    expect(detail.priceCents).toBe(own.priceCents)
    const list = (await teamLead.get('/api/v1/catalog/items?kind=material')).json() as CatalogItem[]
    expect(list.map((i) => i.costCents)).toEqual([null])
    const csv = (await teamLead.get('/api/v1/catalog/export.csv?kind=material')).body
    expect(csv).not.toContain('7,77')
    expect((await teamLead.get('/api/v1/supplier-articles?q=grund')).statusCode).toBe(403)
  })

  it('leaves the Kalkulation out of documents without price.view', async () => {
    const own = (await admin.get(`/api/v1/documents/${quoteId}`)).json() as DocumentDetail
    expect(own.totals.costCents).toBe(3300)
    const doc = (await auditor.get(`/api/v1/documents/${quoteId}`)).json() as DocumentDetail
    const position = doc.items.find((i) => i.id === positionId)
    expect(position).toMatchObject({ costLines: [], calculation: null })
    expect(doc.totals).toMatchObject({ costCents: null, marginCents: null })
    expect(doc.totals.netCents).toBe(own.totals.netCents)
  })

  it('shows only visible projects with a contact and keeps the Auskunft complete', async () => {
    const asAdmin = (await admin.get(`/api/v1/contacts/${customerId}`)).json() as ContactDetail
    expect(asAdmin.projects.map((p) => p.name)).toEqual(['Geheimes Projekt'])
    for (const client of [teamLead, projectLead]) {
      const contact = (await client.get(`/api/v1/contacts/${customerId}`)).json() as ContactDetail
      expect(contact.projects).toEqual([])
    }
    expect(
      (await projectLead.get(`/api/v1/contacts/${customerId}/privacy-report`)).statusCode,
    ).toBe(403)
    expect((await admin.get(`/api/v1/contacts/${customerId}/privacy-report`)).statusCode).toBe(200)
  })
})
