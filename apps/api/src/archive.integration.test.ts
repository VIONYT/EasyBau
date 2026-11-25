import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withTenant } from '@easybau/db'
import type { DocumentDetail, OperationsStatus } from '@easybau/schemas'
import {
  type ArchiveStore,
  FsObjectStore,
  MemoryArchiveStore,
  S3ArchiveStore,
} from '@easybau/storage'
import { archivePending, verifyRequested } from '@easybau/worker'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

const silent = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
}

/**
 * Revisionssicheres Archiv (ADR 0008): finalized originals reach the WORM bucket via the worker,
 * the document shows the state, and the originals stay available even without the files volume.
 * With ARCHIVE_S3_ENDPOINT (Docker pipeline, CI) the real S3 (RustFS) is used.
 */
describe.skipIf(!process.env.DATABASE_URL)('Belegarchiv (integration)', () => {
  let h: Harness
  let admin: Client
  let tenantId: string
  let archive: ArchiveStore
  let invoice: DocumentDetail

  beforeAll(async () => {
    archive = process.env.ARCHIVE_S3_ENDPOINT
      ? new S3ArchiveStore({
          endpoint: process.env.ARCHIVE_S3_ENDPOINT,
          region: 'us-east-1',
          bucket: `api-${randomUUID().slice(0, 8)}`,
          accessKeyId: process.env.ARCHIVE_S3_ACCESS_KEY as string,
          secretAccessKey: process.env.ARCHIVE_S3_SECRET_KEY as string,
          forcePathStyle: true,
        })
      : new MemoryArchiveStore()
    await archive.ensureBucket()
    h = await createHarness({ requireAdminMfa: false, archive })
    admin = new Client(h.app)
    const setup = await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Archiv Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    tenantId = setup.json().tenant.id
    await admin.patch('/api/v1/settings/company', {
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
    })
    const customer = await admin.post('/api/v1/contacts', {
      kind: 'organization',
      organizationName: 'Wohnbau Nord eG',
      addresses: [{ kind: 'main', street: 'Lindenweg 4', postalCode: '30159', city: 'Hannover' }],
    })
    const project = await admin.post('/api/v1/projects', { name: 'Lindenweg' })
    const units = (await admin.get('/api/v1/units')).json() as { id: string; symbol: string }[]
    const draft = (
      await admin.post(`/api/v1/projects/${project.json().id}/documents`, {
        type: 'invoice',
        invoiceKind: 'standard',
      })
    ).json() as DocumentDetail
    await admin.patch(`/api/v1/documents/${draft.id}`, {
      contactId: customer.json().id,
      documentDate: '2026-11-20',
      serviceFrom: '2026-11-02',
    })
    await admin.post(`/api/v1/documents/${draft.id}/items`, {
      positionType: 'item',
      shortText: 'Wände streichen',
      quantity: '40',
      unitId: units.find((u) => u.symbol === 'm²')?.id,
      unitPriceCents: 1250,
    })
    const res = await admin.post(`/api/v1/documents/${draft.id}/finalize`, {})
    expect(res.statusCode, res.body).toBe(200)
    invoice = res.json()
  })

  afterAll(async () => {
    await h?.close()
  })

  it('shows originals as pending until the worker archived them', async () => {
    // Finalize stores ZUGFeRD XML, report and (right after the transaction) the PDF/A-3.
    const doc = (await admin.get(`/api/v1/documents/${invoice.id}`)).json() as DocumentDetail
    expect(doc.archive).toEqual({
      enabled: true,
      files: 3,
      archived: 0,
      retainUntil: '2036-12-31',
      archivedAt: null,
    })
    const ops = (await admin.get('/api/v1/settings/operations')).json() as OperationsStatus
    expect(ops.archive).toMatchObject({
      configured: true,
      reachable: true,
      objectLock: true,
      mode: 'COMPLIANCE',
      pending: 3,
      failing: 0,
    })
  })

  it('archives every original with retention and checksum (WORM)', async () => {
    await archivePending(h.sql, new FsObjectStore(h.storageDir), archive, silent, 1000)
    const doc = (await admin.get(`/api/v1/documents/${invoice.id}`)).json() as DocumentDetail
    expect(doc.archive).toMatchObject({
      files: 3,
      archived: 3,
      archivedAt: expect.stringMatching(/Z$/),
    })
    const rows = await withTenant(
      h.sql,
      { tenantId },
      (tx) =>
        tx<{ key: string; sha256: string; retainUntil: Date }[]>`
        select r.object_key as key, encode(r.sha256, 'hex') as sha256, r.retain_until as "retainUntil"
        from artifact_archive r join document_artifact a on a.id = r.artifact_id
        where a.document_id = ${invoice.id}`,
    )
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      // § 147 AO: 10 years after the end of 2026 → locked through 31.12.2036.
      expect(row.retainUntil.toISOString()).toBe('2037-01-01T00:00:00.000Z')
      expect(await archive.head(row.key)).toMatchObject({ sha256: row.sha256, mode: 'COMPLIANCE' })
    }
    const ops = (await admin.get('/api/v1/settings/operations')).json() as OperationsStatus
    expect(ops.archive).toMatchObject({ pending: 0, failing: 0, oldestPendingAt: null })
  })

  it('reconciles the archive completely on request (Betriebs-Check)', async () => {
    const res = await admin.post('/api/v1/settings/operations/archive-verify', {})
    expect(res.statusCode, res.body).toBe(202)
    expect((await admin.post('/api/v1/settings/operations/archive-verify', {})).statusCode).toBe(
      409,
    )
    let ops = (await admin.get('/api/v1/settings/operations')).json() as OperationsStatus
    expect(ops.archive.verify).toMatchObject({
      unchecked: 3,
      request: { reason: 'manual', startedAt: null, finishedAt: null },
    })
    const files = new FsObjectStore(h.storageDir)
    for (let i = 0; i < 5; i++) await verifyRequested(h.sql, files, archive, null, silent, 2)
    ops = (await admin.get('/api/v1/settings/operations')).json() as OperationsStatus
    expect(ops.archive.verify).toMatchObject({
      checked30d: 3,
      restored30d: 0,
      lost: 0,
      unchecked: 0,
      lastCheckAt: expect.stringMatching(/Z$/),
      request: { checked: 3, restored: 0, lost: 0, finishedAt: expect.stringMatching(/Z$/) },
    })
  })

  it('serves the originals from the archive when the working copy is lost', async () => {
    const before = await admin.get(`/api/v1/documents/${invoice.id}/pdf`)
    const xmlBefore = await admin.get(`/api/v1/documents/${invoice.id}/einvoice/zugferd`)
    // Simulate a restore without the files volume.
    await rm(join(h.storageDir, 'objects', tenantId, 'documents'), { recursive: true, force: true })
    const after = await admin.get(`/api/v1/documents/${invoice.id}/pdf`)
    expect(after.statusCode).toBe(200)
    expect(after.rawPayload.equals(before.rawPayload)).toBe(true)
    const xmlAfter = await admin.get(`/api/v1/documents/${invoice.id}/einvoice/zugferd`)
    expect(xmlAfter.body).toBe(xmlBefore.body)
  })
})
