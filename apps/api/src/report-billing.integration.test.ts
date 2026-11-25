import type {
  BillableReport,
  CancelInvoiceResult,
  DocumentDetail,
  ReportDetail,
  ReportSummary,
} from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Regieberichte abrechnen (P2.5): a signed Regiebericht becomes a title with positions in an
 * invoice draft; finalizing marks it as billed, a Storno with „Rechnung korrigieren“ bills it again.
 */
describe.skipIf(!process.env.DATABASE_URL)('Regieberichte in Rechnung (integration)', () => {
  let h: Harness
  let admin: Client
  let projectId: string
  let otherProjectId: string
  let customerId: string
  let units: { id: string; symbol: string }[]
  let signed: ReportDetail
  let unsigned: ReportDetail
  let foreign: ReportDetail
  let draft: DocumentDetail

  async function report(project: string, date: string, sign: boolean) {
    const created = (
      await admin.post(`/api/v1/projects/${project}/reports`, {
        templateKey: 'daywork_report',
        reportDate: date,
      })
    ).json() as ReportDetail
    const [me] = await h.adminSql<{ id: string }[]>`select id from app_user limit 1`
    const patched = await admin.patch(`/api/v1/reports/${created.id}`, {
      serviceFrom: '2026-11-03',
      serviceTo: date,
      data: {
        staff: {
          rows: [
            { name: 'Chef', userId: me?.id, hours: '2.5', activity: 'Wand gestemmt' },
            { name: 'Max Muster', hours: '3' },
          ],
        },
        services: {
          rows: [
            {
              description: 'Schlitz gestemmt',
              quantity: '4.255',
              unitId: units.find((u) => u.symbol === 'm')?.id,
            },
          ],
        },
        materials: { rows: [{ description: 'Zementmörtel' }] },
        equipment: { rows: [{ description: 'Bohrhammer', hours: '2' }] },
      },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    if (!sign) return patched.json() as ReportDetail
    const res = await admin.post(`/api/v1/reports/${created.id}/sign`, {
      signatures: [
        { role: 'contractor', name: 'Chef' },
        { role: 'client', name: 'Frau Berger' },
      ],
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as ReportDetail
  }

  async function invoiceDraft() {
    const doc = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    await admin.patch(`/api/v1/documents/${doc.id}`, {
      contactId: customerId,
      documentDate: '2026-11-10',
      serviceFrom: '2026-11-03',
      serviceTo: '2026-11-05',
      paymentDueDays: 14,
    })
    return doc
  }

  const candidates = async (docId: string) =>
    (await admin.get(`/api/v1/documents/${docId}/reports`)).json() as BillableReport[]

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Regie Bau GmbH' },
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
    // Geselle first (fallback for people without Lohngruppe), the admin is Meister.
    await admin.post('/api/v1/settings/wage-groups', {
      name: 'Geselle',
      costPerHourCents: 4000,
      markupPercent: '25',
    })
    const meister = (
      await admin.post('/api/v1/settings/wage-groups', {
        name: 'Meister',
        costPerHourCents: 5000,
        markupPercent: '20',
      })
    ).json()
    await h.adminSql`update wage_group set sort = 99 where id = ${meister.id}`
    await h.adminSql`update membership set wage_group_id = ${meister.id}`
    customerId = (
      await admin.post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Wohnbau Nord eG',
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
      })
    ).json().id
    projectId = (await admin.post('/api/v1/projects', { name: 'Lindenweg', customerId })).json().id
    otherProjectId = (await admin.post('/api/v1/projects', { name: 'Anderswo' })).json().id
    units = (await admin.get('/api/v1/units')).json()
    signed = await report(projectId, '2026-11-05', true)
    unsigned = await report(projectId, '2026-11-06', false)
    foreign = await report(otherProjectId, '2026-11-05', true)
    draft = await invoiceDraft()
  })

  afterAll(async () => {
    await h?.close()
  })

  it('lists the billable reports of the project with the reason when they cannot be taken over', async () => {
    const list = await candidates(draft.id)
    expect(list.map((r) => [r.id, r.blocked])).toEqual([
      [signed.id, null],
      [unsigned.id, 'Der Bericht ist noch nicht unterschrieben.'],
    ])
    expect(list[0]).toMatchObject({ totalHours: '5.5', inThisDocument: false })
  })

  it('takes a signed report over as title with positions', async () => {
    const res = await admin.post(`/api/v1/documents/${draft.id}/apply-reports`, {
      reportIds: [signed.id],
    })
    expect(res.statusCode, res.body).toBe(200)
    const doc = res.json() as DocumentDetail
    const rows = doc.items.map((i) => ({
      type: i.positionType,
      text: i.shortText,
      qty: i.quantity,
      unit: i.unit?.symbol ?? null,
      price: i.unitPriceCents,
    }))
    expect(rows).toEqual([
      {
        type: 'title',
        text: 'Regiebericht vom 05.11.2026 (Leistungszeitraum 03.11.2026 – 05.11.2026)',
        qty: null,
        unit: null,
        price: null,
      },
      { type: 'item', text: 'Stundenlohnarbeiten Meister', qty: '2.5', unit: 'Std', price: 6000 },
      { type: 'item', text: 'Stundenlohnarbeiten Geselle', qty: '3', unit: 'Std', price: 5000 },
      { type: 'item', text: 'Schlitz gestemmt', qty: '4.26', unit: 'm', price: 0 },
      { type: 'item', text: 'Zementmörtel', qty: '1', unit: 'psch', price: 0 },
      { type: 'item', text: 'Bohrhammer', qty: '2', unit: 'Std', price: 0 },
    ])
    expect(doc.items[1]?.longText).toBe('Chef: 2,5 Std. – Wand gestemmt')
    expect(doc.totals.netCents).toBe(30_000)
    // Stundenlohn counts as Lohnkosten (§ 35a): one labor line per hour from the Lohngruppe.
    expect(doc.items[1]?.calculation?.costCents).toBe(12_500)
    expect(doc.totals.laborShare.netCents).toBe(30_000)
    expect((await candidates(draft.id))[0]).toMatchObject({ inThisDocument: true, blocked: null })

    // Not twice, not unsigned, not from another project.
    const twice = await admin.post(`/api/v1/documents/${draft.id}/apply-reports`, {
      reportIds: [signed.id],
    })
    expect(twice.statusCode).toBe(409)
    for (const id of [unsigned.id, foreign.id]) {
      const res = await admin.post(`/api/v1/documents/${draft.id}/apply-reports`, {
        reportIds: [id],
      })
      expect(res.statusCode).toBe(409)
    }
    const other = await invoiceDraft()
    expect((await candidates(other.id))[0]?.blocked).toBe(
      'Bereits in einem anderen Rechnungsentwurf enthalten.',
    )
    await admin.delete(`/api/v1/documents/${other.id}`)
  })

  it('marks the report as billed at Festschreiben and releases it after a Storno', async () => {
    const check = (await admin.get(`/api/v1/documents/${draft.id}/finalize-check`)).json()
    expect(JSON.stringify(check.warnings)).toContain('Stundenlohnarbeiten sind nur abrechenbar')
    // Leistungen/Material/Geräte come over at 0 €: the office has to add the prices.
    expect(JSON.stringify(check.warnings)).toContain(
      '3 Positionen haben keinen Preis (0,00 €): Position 1.3 „Schlitz gestemmt“',
    )
    const finalized = await admin.post(`/api/v1/documents/${draft.id}/finalize`, {
      acknowledgeWarnings: true,
    })
    expect(finalized.statusCode, finalized.body).toBe(200)
    const number = finalized.json().number as string
    const summary = async () =>
      ((await admin.get(`/api/v1/projects/${projectId}/reports`)).json() as ReportSummary[]).find(
        (r) => r.id === signed.id,
      )
    expect(await summary()).toMatchObject({ billable: true, billedInvoice: { number } })

    const fresh = await invoiceDraft()
    expect((await candidates(fresh.id))[0]?.blocked).toBe(
      `Bereits abgerechnet mit Rechnung ${number}.`,
    )
    await admin.delete(`/api/v1/documents/${fresh.id}`)

    // Storno + „Rechnung korrigieren“: the corrected draft carries the report and bills it again.
    const cancel = await admin.post(`/api/v1/documents/${draft.id}/cancel`, {
      reason: 'Stunden falsch',
      reissue: true,
    })
    expect(cancel.statusCode, cancel.body).toBe(201)
    const result = cancel.json() as CancelInvoiceResult
    expect((await summary())?.billedInvoice).toBeNull()
    const reissueId = result.reissue?.id as string
    expect((await candidates(reissueId))[0]).toMatchObject({ inThisDocument: true, blocked: null })
    const again = await admin.post(`/api/v1/documents/${reissueId}/finalize`, {
      acknowledgeWarnings: true,
    })
    expect(again.statusCode, again.body).toBe(200)
    expect((await summary())?.billedInvoice?.number).toBe(again.json().number)
    // The report itself stays unchanged evidence.
    expect(
      (await admin.patch(`/api/v1/reports/${signed.id}`, { reportDate: '2026-11-07' })).statusCode,
    ).toBe(409)
  })
})
