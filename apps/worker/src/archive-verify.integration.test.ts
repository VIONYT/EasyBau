import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  createDraftInvoice,
  createProject,
  createTenant,
  finalizeDocument,
  openTestDb,
  type TestDb,
  type TestTenant,
  testDatabaseUrl,
} from '@easybau/db/test-support'
import { FsObjectStore, MemoryArchiveStore, S3ArchiveStore } from '@easybau/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { archivePending } from './archive.js'
import { verifyArchive, verifyRequested } from './archive-verify.js'

const silent = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest()

interface CheckRow {
  artifactId: string
  result: string
  problem: string | null
  source: string | null
  deep: boolean
}

/**
 * Archiv-Abgleich (ADR 0008): archived originals are checked in the bucket; missing or damaged
 * ones are written again (new version, original retention) from an intact copy.
 */
describe.skipIf(!testDatabaseUrl)('Archiv-Abgleich (integration)', () => {
  let db: TestDb
  let dir: string
  let files: FsObjectStore
  let tenant: TestTenant
  let other: TestTenant
  let documentId: string
  const archive = new MemoryArchiveStore()
  const originals: { id: string; key: string; data: Buffer }[] = []

  async function original(content: string) {
    const data = Buffer.from(content)
    const id = randomUUID()
    const key = `${tenant.tenantId}/documents/${documentId}/${id}`
    const pending = await files.receive(Readable.from([data]), { maxBytes: 1024 })
    await pending.commit(key)
    await tenant.run(
      (tx) => tx`
        insert into document_artifact (id, tenant_id, document_id, kind, storage_key, sha256, size_bytes,
                                       mime_type, locked_until)
        values (${id}, ${tenant.tenantId}, ${documentId}, 'pdf', ${key}, ${sha(data)}, ${data.length},
                'application/pdf', '2036-12-31')`,
    )
    return { id, key, data }
  }
  const verify = (options: { before?: Date; deepEvery?: number } = {}) =>
    verifyArchive(db.app, files, archive, null, silent, {
      limit: 50,
      deepEvery: options.deepEvery ?? 1,
      tenantId: tenant.tenantId,
      before: options.before ?? new Date(Date.now() + 60_000),
    })
  const latestChecks = () =>
    tenant.run(
      (tx) => tx<CheckRow[]>`
        select distinct on (artifact_id) artifact_id as "artifactId", result, problem, source, deep
        from artifact_archive_check order by artifact_id, checked_at desc`,
    )

  beforeAll(async () => {
    db = await openTestDb()
    dir = await mkdtemp(join(tmpdir(), 'easybau-verify-'))
    files = new FsObjectStore(dir)
    tenant = await createTenant(db, 'Abgleich A')
    other = await createTenant(db, 'Abgleich B')
    documentId = await tenant.run(async (tx) => {
      const { projectId } = await createProject(tx, tenant.tenantId)
      const { documentId: id } = await createDraftInvoice(tx, tenant.tenantId, projectId)
      await finalizeDocument(tx, id)
      return id
    })
    originals.push(await original('%PDF-1.7 Rechnung'), await original('<Invoice/>'))
    await archivePending(db.app, files, archive, silent, 500)
    expect(originals.every((o) => archive.objects.has(o.key))).toBe(true)
  })
  afterAll(async () => {
    await db?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('finds intact objects by metadata and content', async () => {
    const run = await verify()
    expect(run).toEqual({ checked: 2, ok: 2, restored: 0, lost: 0 })
    const checks = await latestChecks()
    expect(checks.map((c) => [c.result, c.problem, c.deep])).toEqual([
      ['ok', null, true],
      ['ok', null, true],
    ])
    // Another company sees none of these results (RLS).
    expect(await other.run((tx) => tx`select id from artifact_archive_check`)).toHaveLength(0)
  })

  it('restores missing, damaged and too briefly locked objects from the working copy', async () => {
    const [first, second] = originals as [(typeof originals)[0], (typeof originals)[0]]
    // Bucket of a new server without this object; wrong content under correct metadata.
    archive.objects.delete(first.key)
    const stored = archive.objects.get(second.key)
    archive.objects.set(second.key, {
      // Same size, other bytes: only the content check finds it.
      data: Buffer.alloc(second.data.length, 'x'),
      sha256: stored?.sha256 as string,
      retainUntil: stored?.retainUntil as Date,
    })
    const run = await verify()
    expect(run).toEqual({ checked: 2, ok: 0, restored: 2, lost: 0 })
    const checks = await latestChecks()
    expect(checks.find((c) => c.artifactId === first.id)).toMatchObject({
      result: 'restored',
      problem: 'missing',
      source: 'working_copy',
    })
    expect(checks.find((c) => c.artifactId === second.id)).toMatchObject({
      result: 'restored',
      problem: 'content',
    })
    expect(archive.objects.get(second.key)?.data.equals(second.data)).toBe(true)
    // The damaged version stays (WORM); the intact one is the newest.
    expect(archive.versions.get(second.key)).toHaveLength(2)
    // Retention ends too early (e.g. a GOVERNANCE lock shortened): written again with the full period.
    const current = archive.objects.get(first.key) as { data: Buffer; sha256: string }
    archive.objects.set(first.key, { ...current, retainUntil: new Date('2027-01-01') })
    expect((await verify({ deepEvery: 1000 })).restored).toBe(1)
    expect(archive.objects.get(first.key)?.retainUntil.toISOString()).toBe(
      '2037-01-01T00:00:00.000Z',
    )
  })

  it('reports an original as lost without an intact copy, takes it from the previous archive', async () => {
    // Archived earlier, but now neither in the bucket nor in the files volume.
    const data = Buffer.from('%PDF-1.7 Altbeleg')
    const id = randomUUID()
    const key = `${tenant.tenantId}/documents/${documentId}/${id}`
    await tenant.run(async (tx) => {
      await tx`
        insert into document_artifact (id, tenant_id, document_id, kind, storage_key, sha256, size_bytes,
                                       mime_type, locked_until)
        values (${id}, ${tenant.tenantId}, ${documentId}, 'pdf', ${key}, ${sha(data)}, ${data.length},
                'application/pdf', '2036-12-31')`
      await tx`
        insert into artifact_archive (artifact_id, tenant_id, bucket, object_key, sha256, retain_until,
                                      retention_mode)
        values (${id}, ${tenant.tenantId}, 'alter-bucket', ${key}, ${sha(data)}, '2037-01-01T00:00:00Z',
                'COMPLIANCE')`
    })
    expect((await verify()).lost).toBe(1)
    expect((await latestChecks()).find((c) => c.artifactId === id)).toMatchObject({
      result: 'lost',
      problem: 'missing',
      source: null,
    })
    // Moving to another S3: the previous archive still has it (a damaged copy is not taken).
    const previous = new MemoryArchiveStore()
    await previous.put(key, Buffer.from('falsch'), {
      sha256: sha(data),
      contentType: 'application/pdf',
      retainUntil: new Date('2037-01-01'),
    })
    const wrong = await verifyArchive(db.app, files, archive, previous, silent, {
      limit: 50,
      deepEvery: 1,
      tenantId: tenant.tenantId,
      before: new Date(Date.now() + 60_000),
    })
    expect(wrong.lost).toBe(1)
    await previous.put(key, data, {
      sha256: sha(data),
      contentType: 'application/pdf',
      retainUntil: new Date('2037-01-01'),
    })
    const run = await verifyArchive(db.app, files, archive, previous, silent, {
      limit: 50,
      deepEvery: 1,
      tenantId: tenant.tenantId,
      before: new Date(Date.now() + 60_000),
    })
    expect(run.restored).toBe(1)
    expect((await latestChecks()).find((c) => c.artifactId === id)?.source).toBe('previous_archive')
    expect(archive.objects.get(key)?.data.equals(data)).toBe(true)
  })

  it('works through a complete reconciliation request in steps and finishes it', async () => {
    await tenant.run(
      (tx) =>
        tx`insert into archive_verify_request (tenant_id, reason) values (${tenant.tenantId}, 'restore')`,
    )
    // Only one open request per company.
    await expect(
      tenant.run(
        (tx) =>
          tx`insert into archive_verify_request (tenant_id, reason) values (${tenant.tenantId}, 'manual')`,
      ),
    ).rejects.toThrow(/archive_verify_request_open_uq/)
    // Other test files may have open requests too: work until ours is finished.
    for (let i = 0; i < 20; i++) {
      const [open] = await tenant.run(
        (tx) => tx`select id from archive_verify_request where finished_at is null`,
      )
      if (!open) break
      await verifyRequested(db.app, files, archive, null, silent, 1)
    }
    const [request] = await tenant.run(
      (tx) => tx<{ checked: number; restored: number; lost: number; finished: boolean }[]>`
        select checked, restored, lost, finished_at is not null as finished from archive_verify_request`,
    )
    expect(request).toEqual({ checked: 3, restored: 0, lost: 0, finished: true })
  })

  it.skipIf(!process.env.ARCHIVE_S3_ENDPOINT)(
    'fills an empty bucket on a new server from the working copy (real S3)',
    async () => {
      const bucket = new S3ArchiveStore({
        endpoint: process.env.ARCHIVE_S3_ENDPOINT as string,
        region: 'us-east-1',
        bucket: `verify-${randomUUID().slice(0, 8)}`,
        accessKeyId: process.env.ARCHIVE_S3_ACCESS_KEY as string,
        secretAccessKey: process.env.ARCHIVE_S3_SECRET_KEY as string,
        forcePathStyle: true,
      })
      await bucket.ensureBucket()
      const options = {
        limit: 50,
        deepEvery: 1,
        tenantId: tenant.tenantId,
        before: new Date(Date.now() + 60_000),
      }
      const run = await verifyArchive(db.app, files, bucket, null, silent, options)
      // The two originals with a working copy come back, the one without stays lost.
      expect(run).toMatchObject({ restored: 2, lost: 1 })
      const [first] = originals
      const head = await bucket.head(first?.key as string)
      expect(head).toMatchObject({
        mode: 'COMPLIANCE',
        sha256: sha(first?.data as Buffer).toString('hex'),
      })
      expect(head?.retainUntil).toMatch(/^2037-01-01T00:00:00/)
      const again = await verifyArchive(db.app, files, bucket, null, silent, options)
      expect(again).toMatchObject({ ok: 2, restored: 0 })
    },
  )
})
