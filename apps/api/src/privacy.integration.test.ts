import { withTenant } from '@easybau/db'
import type { ContactDetail, ContactPrivacy, DocumentDetail } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** Datenschutz (DSGVO Art. 15, 17, 18): Auskunft, Löschen oder Sperren bis Fristende. */
describe.skipIf(!process.env.DATABASE_URL)('Datenschutz bei Kontakten (integration)', () => {
  let h: Harness
  let admin: Client
  let tenantId: string
  let lead: ContactDetail
  let customer: ContactDetail
  let projectId: string
  let invoice: DocumentDetail

  const privacy = async (id: string) =>
    (await admin.get(`/api/v1/contacts/${id}/privacy`)).json() as ContactPrivacy

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Datenschutz Bau GmbH' },
      admin: { email: 'chef@example.test', password: 'ein-sehr-langes-passwort', displayName: 'C' },
    })
    tenantId = setup.json().tenant.id
    await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
      email: 'buero@example.test',
    })
    lead = (
      await admin.post('/api/v1/contacts', {
        kind: 'person',
        firstName: 'Lena',
        lastName: 'Interessentin',
        addresses: [{ kind: 'main', street: 'Rosenweg 3', postalCode: '30159', city: 'Hannover' }],
        channels: [{ kind: 'email', value: 'lena@example.test' }],
      })
    ).json()
    customer = (
      await admin.post('/api/v1/contacts', {
        kind: 'person',
        firstName: 'Karl',
        lastName: 'Kunde',
        assignCustomerNumber: true,
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
        channels: [{ kind: 'email', value: 'karl@example.test' }],
      })
    ).json()
    projectId = (
      await admin.post('/api/v1/projects', { name: 'Bad Kunde', customerId: customer.id })
    ).json().id
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    await admin.post(`/api/v1/documents/${draft.id}/items`, {
      positionType: 'item',
      shortText: 'Fliesen',
      quantity: '10',
      unitId: units.find((u) => u.symbol === 'm²')?.id,
      unitPriceCents: 5000,
    })
    await admin.patch(`/api/v1/documents/${draft.id}`, {
      documentDate: '2026-11-05',
      serviceFrom: '2026-11-02',
      serviceTo: '2026-11-04',
      paymentDueDays: 14,
    })
    const done = await admin.post(`/api/v1/documents/${draft.id}/finalize`, {
      acknowledgeWarnings: true,
    })
    expect(done.statusCode, done.body).toBe(200)
    invoice = done.json()
  })

  afterAll(async () => {
    await h?.close()
  })

  it('erases a contact without tax-relevant records at once', async () => {
    expect(await privacy(lead.id)).toMatchObject({
      retentionEnd: null,
      action: 'erase',
      usage: { projects: 0, documents: 0, finalizedDocuments: 0, incomingInvoices: 0 },
    })
    expect((await admin.post(`/api/v1/contacts/${lead.id}/erase`, {})).statusCode).toBe(400)
    const res = await admin.post(`/api/v1/contacts/${lead.id}/erase`, { confirm: true })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({
      result: 'erased',
      blockedUntil: null,
      duplicates: { erased: 0, blocked: 0 },
    })

    const erased = (await admin.get(`/api/v1/contacts/${lead.id}`)).json() as ContactDetail
    expect(erased).toMatchObject({
      displayName: 'Gelöschter Kontakt',
      firstName: null,
      archived: true,
      channels: [],
      addresses: [],
    })
    expect(erased.erasedAt).not.toBeNull()
    const patch = await admin.patch(
      `/api/v1/contacts/${lead.id}`,
      { firstName: 'Lena' },
      { 'if-match': (await admin.get(`/api/v1/contacts/${lead.id}`)).headers.etag as string },
    )
    expect(patch.statusCode).toBe(409)
    expect(
      (await admin.post(`/api/v1/contacts/${lead.id}/erase`, { confirm: true })).statusCode,
    ).toBe(409)
    // Nothing of the person is left in the contact tables.
    const left = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx`
      select 1 from contact_channel where value = 'lena@example.test'
      union all select 1 from contact_address where street = 'Rosenweg 3'
      union all select 1 from contact where first_name = 'Lena'`,
    )
    expect(left).toHaveLength(0)
    // Nor in the Änderungsprotokoll: the payload is removed, the hash chain stays intact.
    const events = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx<{ before: unknown; after: unknown; redacted: boolean }[]>`
        select before, after, redacted_at is not null as redacted from audit_event
        where entity = 'contact' and entity_id = ${lead.id} and hash_version = 2 order by seq`,
    )
    expect(events.filter((e) => e.redacted).length).toBeGreaterThanOrEqual(2)
    expect(events.every((e) => e.before === null && e.after === null)).toBe(true)
    const chain = await admin.post('/api/v1/audit/chain/check', {})
    expect(chain.json().last).toMatchObject({ problem: null })
    // Only redaction is allowed – any other change of the protocol is still refused.
    await expect(
      h.adminSql`update audit_event set action = 'x' where entity_id = ${lead.id}`,
    ).rejects.toThrow(/append-only/)
    await expect(
      h.adminSql`update audit_event set after = '{}'::jsonb where entity_id = ${lead.id}`,
    ).rejects.toThrow(/append-only/)
  })

  it('anonymises the projects of an erased private customer', async () => {
    const person = (
      await admin.post('/api/v1/contacts', {
        kind: 'person',
        firstName: 'Paula',
        lastName: 'Privat',
        assignCustomerNumber: true,
      })
    ).json() as ContactDetail
    const project = (
      await admin.post('/api/v1/projects', {
        name: 'Bad Familie Privat',
        customerId: person.id,
        site: { street: 'Gartenweg 7', postalCode: '30161', city: 'Hannover' },
      })
    ).json()
    // Only a draft: nothing to keep, so the contact is erased at once.
    await admin.post(`/api/v1/projects/${project.id}/documents`, { type: 'quote' })
    const plan = await privacy(person.id)
    expect(plan).toMatchObject({ action: 'erase', usage: { projects: 1, files: 0, reports: 0 } })
    expect(
      (await admin.post(`/api/v1/contacts/${person.id}/erase`, { confirm: true })).json(),
    ).toEqual({ result: 'erased', blockedUntil: null, duplicates: { erased: 0, blocked: 0 } })
    const [row] = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx<{ name: string; street: string | null; city: string | null; archived: boolean }[]>`
        select name, site_street as street, site_city as city, archived_at is not null as archived
        from project where id = ${project.id}`,
    )
    expect(row).toMatchObject({ street: null, city: null, archived: true })
    expect(row?.name).toMatch(/^(Projekt |Gelöschtes Projekt)/)
    const [left] = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from audit_event
        where entity = 'project' and entity_id = ${project.id} and after::text like '%Gartenweg%'`,
    )
    expect(left?.n).toBe(0)
  })

  it('blocks a customer with a finalized invoice until the retention period ends', async () => {
    const before = await privacy(customer.id)
    expect(before).toMatchObject({
      retentionEnd: '2036-12-31',
      action: 'block',
      usage: { projects: 1, documents: 1, finalizedDocuments: 1 },
    })
    const res = await admin.post(`/api/v1/contacts/${customer.id}/erase`, { confirm: true })
    expect(res.json()).toEqual({
      result: 'blocked',
      blockedUntil: '2036-12-31',
      duplicates: { erased: 0, blocked: 0 },
    })
    const blocked = (await admin.get(`/api/v1/contacts/${customer.id}`)).json() as ContactDetail
    expect(blocked).toMatchObject({ blockedUntil: '2036-12-31', erasedAt: null, archived: true })
    // Kept for the retention period, but not used any more (Art. 18).
    expect(blocked.lastName).toBe('Kunde')
    expect((await admin.post(`/api/v1/contacts/${customer.id}/unarchive`, {})).statusCode).toBe(404)
    const project = await admin.post('/api/v1/projects', { name: 'Neu', customerId: customer.id })
    expect(project.statusCode).toBe(400)
    expect(project.json().errors.customerId).toBe('Unbekannter Kunde.')
    const doc = await admin.post(`/api/v1/projects/${projectId}/documents`, {
      type: 'invoice',
      invoiceKind: 'standard',
    })
    expect(doc.statusCode).toBe(409)
    expect(doc.json().detail).toMatch(/Datenschutzgründen gesperrt/)
    // The finalized invoice keeps its snapshot.
    const kept = (await admin.get(`/api/v1/documents/${invoice.id}`)).json() as DocumentDetail
    expect(kept.number).toBe(invoice.number)
  })

  it('gives an Auskunft with all data stored about the contact and records it', async () => {
    const res = await admin.get(`/api/v1/contacts/${customer.id}/privacy-report`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Auskunft_DSGVO_/)
    const report = res.json()
    expect(report['Auskunft nach Art. 15 DSGVO']).toMatchObject({
      Verantwortlicher: { name: 'Datenschutz Bau GmbH', email: 'buero@example.test' },
      'Aufbewahrung bis': '2036-12-31',
    })
    expect(report.Stammdaten).toMatchObject({
      Vorname: 'Karl',
      Nachname: 'Kunde',
      'Gesperrt bis': '2036-12-31',
    })
    expect(report.Anschriften).toEqual([
      expect.objectContaining({ Straße: 'Lindenweg 4', Ort: 'Hannover' }),
    ])
    expect(report.Kommunikation).toEqual([expect.objectContaining({ Wert: 'karl@example.test' })])
    expect(report.Projekte).toEqual([expect.objectContaining({ Name: 'Bad Kunde' })])
    expect(report.Dokumente).toEqual([
      expect.objectContaining({
        Art: 'invoice',
        Nummer: invoice.number,
        'Aufbewahrung bis': '2036-12-31',
      }),
    ])
    expect(Object.keys(report.Hinweise)).toEqual([
      'Zwecke',
      'Rechtsgrundlagen',
      'Empfänger',
      'Speicherdauer',
      'Rechte',
      'Herkunft',
    ])
    const events = await withTenant(
      h.sql,
      { tenantId },
      (tx) => tx<{ action: string }[]>`
      select action from audit_event where entity = 'contact' and entity_id = ${customer.id}
        and action like 'privacy_%' order by seq`,
    )
    expect(events.map((e) => e.action)).toEqual(['privacy_block', 'privacy_report'])
  })

  it('keeps the privacy functions within the company', async () => {
    const other = await createHarness({ requireAdminMfa: false })
    try {
      const outsider = new Client(other.app)
      await outsider.post('/api/v1/setup', {
        setupToken: other.setupToken,
        company: { name: 'Fremd GmbH' },
        admin: { email: 'x@example.test', password: 'ein-sehr-langes-passwort', displayName: 'X' },
      })
      expect((await outsider.get(`/api/v1/contacts/${customer.id}/privacy`)).statusCode).toBe(404)
    } finally {
      await other.close()
    }
    expect(
      (await admin.get(`/api/v1/contacts/00000000-0000-7000-8000-000000000000/privacy`)).statusCode,
    ).toBe(404)
  })
})
