import type { ContactDetail, DocumentDetail, MergeContactResult } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** Kontakte zusammenführen (Dubletten) and Ansprechpartner („z. Hd.“) in documents. */
describe.skipIf(!process.env.DATABASE_URL)('Kontakte zusammenführen, z. Hd. (integration)', () => {
  let h: Harness
  let admin: Client
  let target: ContactDetail
  let duplicate: ContactDetail
  let person: ContactDetail
  let projectId: string
  let unitId: string

  const contact = async (body: Record<string, unknown>) =>
    (await admin.post('/api/v1/contacts', body)).json() as ContactDetail
  const etagOf = async (id: string) =>
    (await admin.get(`/api/v1/documents/${id}`)).headers.etag as string

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Dubletten Bau GmbH' },
      admin: { email: 'chef@example.test', password: 'ein-sehr-langes-passwort', displayName: 'C' },
    })
    await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
    })
    target = await contact({
      kind: 'organization',
      organizationName: 'Wohnbau Nord eG',
      assignCustomerNumber: true,
      addresses: [{ kind: 'main', street: 'Hafenstraße 1', postalCode: '20457', city: 'Hamburg' }],
      channels: [{ kind: 'email', value: 'info@wohnbau.test' }],
    })
    duplicate = await contact({
      kind: 'organization',
      organizationName: 'Wohnbau Nord',
      addresses: [
        { kind: 'main', street: 'Hafenstr. 1', postalCode: '20457', city: 'Hamburg' },
        {
          kind: 'billing',
          recipientBlock: 'Wohnbau Nord eG\nBuchhaltung',
          street: 'Postfach 12',
          postalCode: '20001',
          city: 'Hamburg',
        },
      ],
      channels: [
        { kind: 'email', value: 'INFO@wohnbau.test' },
        { kind: 'phone', value: '040 123456' },
      ],
    })
    person = await contact({
      kind: 'person',
      salutation: 'Frau',
      firstName: 'Anna',
      lastName: 'Schmidt',
    })
    await admin.post(`/api/v1/contacts/${person.id}/links`, {
      organizationId: duplicate.id,
      role: 'Bauleitung',
    })
    projectId = (
      await admin.post('/api/v1/projects', { name: 'Hafencity', customerId: duplicate.id })
    ).json().id
    unitId = ((await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]).find(
      (u) => u.symbol === 'm²',
    )?.id as string
  })

  afterAll(async () => {
    await h?.close()
  })

  it('prints the Ansprechpartner as „z. Hd.“ and only accepts linked persons', async () => {
    const doc = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, { type: 'quote' })
    ).json() as DocumentDetail
    expect(doc.contact?.id).toBe(duplicate.id)
    const stranger = await contact({ kind: 'person', firstName: 'Ex', lastName: 'Fremd' })
    const wrong = await admin.patch(
      `/api/v1/documents/${doc.id}`,
      { contactPersonId: stranger.id },
      { 'if-match': await etagOf(doc.id) },
    )
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().errors.contactPersonId).toMatch(/kein Ansprechpartner/)
    const res = await admin.patch(
      `/api/v1/documents/${doc.id}`,
      { contactPersonId: person.id },
      { 'if-match': await etagOf(doc.id) },
    )
    expect(res.statusCode, res.body).toBe(200)
    const updated = res.json() as DocumentDetail
    expect(updated.contactPerson).toEqual({ id: person.id, displayName: 'Schmidt, Anna' })
    expect(updated.recipient?.lines[0]).toBe('z. Hd. Frau Anna Schmidt')
    // Another recipient drops a person who is not linked to it.
    const other = await admin.patch(
      `/api/v1/documents/${doc.id}`,
      { contactId: target.id },
      { 'if-match': await etagOf(doc.id) },
    )
    expect((other.json() as DocumentDetail).contactPerson).toBeNull()
    await admin.patch(
      `/api/v1/documents/${doc.id}`,
      { contactId: duplicate.id, contactPersonId: person.id },
      { 'if-match': await etagOf(doc.id) },
    )
  })

  it('merges a duplicate: moves what may change, keeps finalised documents', async () => {
    const invoice = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    await admin.post(`/api/v1/documents/${invoice.id}/items`, {
      positionType: 'item',
      shortText: 'Fliesen',
      quantity: '10',
      unitId,
      unitPriceCents: 5000,
    })
    await admin.patch(
      `/api/v1/documents/${invoice.id}`,
      {
        documentDate: '2026-11-05',
        serviceFrom: '2026-11-02',
        serviceTo: '2026-11-04',
        paymentDueDays: 14,
      },
      { 'if-match': await etagOf(invoice.id) },
    )
    const done = await admin.post(`/api/v1/documents/${invoice.id}/finalize`, {
      acknowledgeWarnings: true,
    })
    expect(done.statusCode, done.body).toBe(200)

    expect(
      (
        await admin.post(`/api/v1/contacts/${duplicate.id}/merge`, {
          intoId: person.id,
          confirm: true,
        })
      ).statusCode,
    ).toBe(409)
    expect(
      (await admin.post(`/api/v1/contacts/${duplicate.id}/merge`, { intoId: target.id }))
        .statusCode,
    ).toBe(400)
    const res = await admin.post(`/api/v1/contacts/${duplicate.id}/merge`, {
      intoId: target.id,
      confirm: true,
    })
    expect(res.statusCode, res.body).toBe(200)
    const result = res.json() as MergeContactResult
    expect(result.moved).toEqual({
      projects: 1,
      documents: 1,
      incomingInvoices: 0,
      links: 1,
      channels: 1,
      addresses: 1,
    })
    expect(result.keptWithDuplicate).toBe(1)
    expect(result.into.projects.map((p) => p.name)).toEqual(['Hafencity'])
    expect(result.into.links).toEqual([
      expect.objectContaining({ contactId: person.id, role: 'Bauleitung' }),
    ])
    expect(result.into.channels.map((c) => c.value).sort()).toEqual([
      '040 123456',
      'info@wohnbau.test',
    ])
    expect(result.into.addresses.map((a) => a.kind).sort()).toEqual(['billing', 'main'])

    const old = (await admin.get(`/api/v1/contacts/${duplicate.id}`)).json() as ContactDetail
    expect(old).toMatchObject({ archived: true, mergedInto: { id: target.id } })
    // The finalised invoice keeps its recipient.
    const kept = (await admin.get(`/api/v1/documents/${invoice.id}`)).json() as DocumentDetail
    expect(kept.contact?.id).toBe(duplicate.id)
    expect(kept.recipient).toMatchObject({
      name: 'Wohnbau Nord eG',
      lines: expect.arrayContaining(['Buchhaltung', 'Postfach 12']),
    })
    // The merged duplicate cannot be used or restored any more.
    expect((await admin.post(`/api/v1/contacts/${duplicate.id}/unarchive`, {})).statusCode).toBe(
      404,
    )
    expect(
      (await admin.post('/api/v1/projects', { name: 'Neu', customerId: duplicate.id })).statusCode,
    ).toBe(400)
    expect(
      (
        await admin.post(`/api/v1/contacts/${duplicate.id}/merge`, {
          intoId: target.id,
          confirm: true,
        })
      ).statusCode,
    ).toBe(409)
  })

  it('erases or blocks merged duplicates together with the contact (DSGVO)', async () => {
    const plan = (await admin.get(`/api/v1/contacts/${target.id}/privacy`)).json()
    expect(plan.usage.duplicates).toBe(1)
    const res = await admin.post(`/api/v1/contacts/${target.id}/erase`, { confirm: true })
    expect(res.statusCode, res.body).toBe(200)
    // The duplicate keeps a finalised invoice: blocked until its retention period ends.
    expect(res.json()).toMatchObject({ result: 'erased', duplicates: { erased: 0, blocked: 1 } })
    const old = (await admin.get(`/api/v1/contacts/${duplicate.id}`)).json() as ContactDetail
    expect(old.blockedUntil).toMatch(/^20\d\d-12-31$/)
  })
})
