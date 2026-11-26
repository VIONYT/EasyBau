import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withTenant } from '@easybau/db'
import type {
  DocumentDetail,
  PurgeDocumentsResult,
  PurgeLogEntry,
  RetentionOverview,
} from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** Belege nach Ablauf der Aufbewahrungsfrist anonymisieren (C.12, migration 0047). */
describe.skipIf(!process.env.DATABASE_URL)('Aufbewahrung und Anonymisieren (integration)', () => {
  let h: Harness
  let admin: Client
  let tenantId: string
  let old: DocumentDetail
  let current: DocumentDetail
  let oldKeys: string[]

  async function invoice(projectId: string, unitId: string, date: string) {
    const draft = (
      await admin.post(`/api/v1/projects/${projectId}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    await admin.post(`/api/v1/documents/${draft.id}/items`, {
      positionType: 'item',
      shortText: 'Fliesen im Bad von Familie Kunde',
      longText: 'Haus Lindenweg 4, Obergeschoss',
      quantity: '10',
      unitId,
      unitPriceCents: 5000,
    })
    await admin.patch(`/api/v1/documents/${draft.id}`, {
      documentDate: date,
      serviceFrom: date,
      serviceTo: date,
      subject: 'Bad Familie Kunde',
      placeOfPerformance: 'Lindenweg 4, 30159 Hannover',
    })
    const done = await admin.post(`/api/v1/documents/${draft.id}/finalize`, {
      acknowledgeWarnings: true,
    })
    expect(done.statusCode, done.body).toBe(200)
    // The PDF original is archived on first download.
    expect((await admin.get(`/api/v1/documents/${draft.id}/pdf`)).statusCode).toBe(200)
    return (await admin.get(`/api/v1/documents/${draft.id}`)).json() as DocumentDetail
  }

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Aufbewahrung Bau GmbH' },
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
    const customer = (
      await admin.post('/api/v1/contacts', {
        kind: 'person',
        firstName: 'Karl',
        lastName: 'Kunde',
        addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
      })
    ).json()
    const projectId = (
      await admin.post('/api/v1/projects', { name: 'Bad Kunde', customerId: customer.id })
    ).json().id
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const m2 = units.find((u) => u.symbol === 'm²')?.id as string
    old = await invoice(projectId, m2, '2010-03-01')
    // A Zahlungserinnerung to the old invoice, issued in 2011 (Handelsbrief: 6 years).
    const now = h.clock.now
    h.clock.now = Date.parse('2011-06-01T10:00:00Z')
    const notice = await admin.post(`/api/v1/documents/${old.id}/dunning`, {})
    expect(notice.statusCode, notice.body).toBeLessThan(300)
    h.clock.now = now
    current = await invoice(projectId, m2, '2026-11-05')
    oldKeys = (
      await h.adminSql<{ key: string }[]>`
        select storage_key as key from document_artifact where document_id = ${old.id}`
    ).map((r) => r.key)
    expect(oldKeys.length).toBeGreaterThan(0)
  })

  afterAll(async () => {
    await h?.close()
  })

  it('lists only documents whose retention period has ended', async () => {
    const overview = (await admin.get('/api/v1/retention')).json() as RetentionOverview
    expect(overview.retentionYears).toBe(10)
    expect(overview.due.map((d) => d.number)).toEqual([old.number])
    expect(overview.due[0]).toMatchObject({
      retentionEnd: '2020-12-31',
      recipient: 'Kunde, Karl',
      originals: oldKeys.length,
    })
  })

  it('stores new originals with the retention of the document type', async () => {
    const [row] = await h.adminSql<{ until: string }[]>`
      select to_char(max(locked_until), 'YYYY-MM-DD') as until
      from document_artifact where document_id = ${current.id}`
    expect(row?.until).toBe('2036-12-31')
    expect((await admin.put('/api/v1/settings/retention', { retentionYears: 7 })).statusCode).toBe(
      400,
    )
    expect((await admin.put('/api/v1/settings/retention', { retentionYears: 8 })).json()).toEqual({
      retentionYears: 8,
    })
    await admin.put('/api/v1/settings/retention', { retentionYears: 10 })
  })

  it('keeps finalized documents immutable without an approval or before the period ends', async () => {
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`update document set subject = null, purged_at = now() where id = ${old.id}`,
      ),
    ).rejects.toThrow(/only be anonymised after its retention period/)
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) =>
          tx`insert into document_purge (document_id, tenant_id, type, number, document_date,
                                       retention_end, approved_by)
           select ${current.id}, ${tenantId}, '', '', current_date, current_date, id
           from app_user limit 1`,
      ),
    ).rejects.toThrow(/has not ended/)
    expect(
      (await admin.post('/api/v1/retention/purge', { documentIds: [old.id] })).statusCode,
    ).toBe(400)
  })

  it('anonymises approved documents and keeps number and amounts', async () => {
    const res = await admin.post('/api/v1/retention/purge', {
      documentIds: [old.id, current.id],
      confirm: true,
    })
    expect(res.statusCode, res.body).toBe(200)
    const result = res.json() as PurgeDocumentsResult
    expect(result.purged).toBe(1)
    expect(result.failed).toEqual([
      { id: current.id, message: 'Die Aufbewahrungsfrist ist noch nicht abgelaufen.' },
    ])

    const doc = (await admin.get(`/api/v1/documents/${old.id}`)).json() as DocumentDetail
    expect(doc.purgedAt).not.toBeNull()
    expect(doc.number).toBe(old.number)
    expect(doc.totals.grossCents).toBe(old.totals.grossCents)
    expect(doc.subject).toBeNull()
    expect(doc.placeOfPerformance).toBeNull()
    expect(doc.recipient?.name).toBe('Gelöschter Empfänger')
    expect(doc.recipient?.lines).toEqual([])
    const item = doc.items.find((i) => i.positionType === 'item')
    expect(item?.shortText).toBe('Gelöscht')
    expect(item?.longText).toBeNull()

    // The dunning notice keeps level and amounts but loses its letter; its PDF is gone too.
    const [notice] = await h.adminSql<{ id: string; letter: unknown; open: string }[]>`
      select id, letter_snapshot as letter, open_amount_cents::text as open
      from dunning_notice where invoice_id = ${old.id}`
    expect(notice?.letter).toBeNull()
    expect(Number(notice?.open)).toBeGreaterThan(0)
    expect((await admin.get(`/api/v1/dunning-notices/${notice?.id}/pdf`)).statusCode).toBe(410)

    // Originals: no download, working copy gone, not archived again.
    expect((await admin.get(`/api/v1/documents/${old.id}/pdf`)).statusCode).toBe(410)
    for (const key of oldKeys) expect(existsSync(join(h.storageDir, key))).toBe(false)
    const pending = await h.sql<{ id: string }[]>`select id from pending_archive_artifacts(1000)`
    const oldArtifacts = await h.adminSql<{ id: string }[]>`
      select id from document_artifact where document_id = ${old.id}`
    expect(pending.map((p) => p.id)).not.toEqual(
      expect.arrayContaining(oldArtifacts.map((a) => a.id)),
    )

    // Änderungsprotokoll: payloads of the document and its items are redacted.
    const events = await h.adminSql<{ before: unknown; after: unknown; entity: string }[]>`
      select before, after, entity from audit_event
      where tenant_id = ${tenantId} and hash_version = 2
        and (entity_id = ${old.id} or entity_id in (select id from document_item where document_id = ${old.id}))`
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.before === null && e.after === null)).toBe(true)

    // The other invoice is untouched.
    const other = (await admin.get(`/api/v1/documents/${current.id}`)).json() as DocumentDetail
    expect(other.purgedAt).toBeNull()
    expect(other.subject).toBe('Bad Familie Kunde')
  })

  it('is final: the anonymised document stays locked, a second approval does nothing', async () => {
    await expect(
      withTenant(
        h.sql,
        { tenantId },
        (tx) => tx`update document set subject = 'wieder da' where id = ${old.id}`,
      ),
    ).rejects.toThrow(/immutable/)
    const again = (
      await admin.post('/api/v1/retention/purge', { documentIds: [old.id], confirm: true })
    ).json() as PurgeDocumentsResult
    expect(again).toEqual({ purged: 0, failed: [] })
    const overview = (await admin.get('/api/v1/retention')).json() as RetentionOverview
    expect(overview.due).toEqual([])
  })

  it('keeps a Löschprotokoll with the WORM copies still to remove', async () => {
    const log = (await admin.get('/api/v1/retention/log')).json() as PurgeLogEntry[]
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      documentId: old.id,
      number: old.number,
      type: 'invoice',
      documentDate: '2010-03-01',
      retentionEnd: '2020-12-31',
      approvedBy: 'C',
      originals: oldKeys.length,
      filesPending: 0,
      archivePending: 0,
    })
    expect(log[0]?.purgedAt).not.toBeNull()
  })

  it('keeps approvals and the log away from other companies (RLS)', async () => {
    const rows = await withTenant(
      h.sql,
      { tenantId: randomUUID() },
      (tx) =>
        tx`select document_id from document_purge union all select document_id from artifact_purge`,
    )
    expect(rows).toHaveLength(0)
  })
})
