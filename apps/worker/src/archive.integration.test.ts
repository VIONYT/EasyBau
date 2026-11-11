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
} from '@opc/db/test-support'
import {
  type ArchivedObject,
  type ArchiveStatus,
  type ArchiveStore,
  FsObjectStore,
  S3ArchiveStore,
} from '@opc/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { archivePending } from './archive.js'

const silent = { warn: () => undefined, info: () => undefined, debug: () => undefined }

/** In-memory stand-in with Object Lock semantics (used without a real S3 endpoint). */
class MemoryArchive implements ArchiveStore {
  readonly bucket = 'test-archive'
  readonly mode = 'COMPLIANCE' as const
  objects = new Map<string, { data: Buffer; sha256: string; retainUntil: Date }>()
  puts = 0
  failKeys = new Set<string>()
  lock = true
  async status(): Promise<ArchiveStatus> {
    return { reachable: true, bucketExists: true, objectLock: this.lock, error: null }
  }
  async ensureBucket() {}
  async put(key: string, data: Buffer, o: { sha256: Buffer; retainUntil: Date }) {
    if (this.failKeys.has(key)) throw new Error('connection refused')
    this.puts += 1
    this.objects.set(key, { data, sha256: o.sha256.toString('hex'), retainUntil: o.retainUntil })
    return { versionId: `v${this.puts}` }
  }
  async get(key: string) {
    return this.objects.get(key)?.data ?? null
  }
  async head(key: string): Promise<ArchivedObject | null> {
    const o = this.objects.get(key)
    return o
      ? {
          sizeBytes: o.data.length,
          retainUntil: o.retainUntil.toISOString(),
          mode: 'COMPLIANCE',
          versionId: 'v-existing',
          sha256: o.sha256,
        }
      : null
  }
}

describe.skipIf(!testDatabaseUrl)('Belegarchiv: Worker archiviert Originale (integration)', () => {
  let db: TestDb
  let dir: string
  let files: FsObjectStore
  let a: TestTenant
  let b: TestTenant
  let documentId: string
  const real = process.env.ARCHIVE_S3_ENDPOINT
    ? new S3ArchiveStore({
        endpoint: process.env.ARCHIVE_S3_ENDPOINT,
        region: 'us-east-1',
        bucket: `worker-${randomUUID().slice(0, 8)}`,
        accessKeyId: process.env.ARCHIVE_S3_ACCESS_KEY as string,
        secretAccessKey: process.env.ARCHIVE_S3_SECRET_KEY as string,
        forcePathStyle: true,
      })
    : null

  /** A finalized invoice with one archived-to-be original in the files volume. */
  async function artifact(tenant: TestTenant, content: string) {
    const data = Buffer.from(content)
    const sha256 = createHash('sha256').update(data).digest()
    const id = randomUUID()
    const key = `${tenant.tenantId}/documents/${documentId}/${id}`
    const pending = await files.receive(Readable.from([data]), { maxBytes: 1024 })
    await pending.commit(key)
    await tenant.run(
      (tx) => tx`
        insert into document_artifact (id, tenant_id, document_id, kind, storage_key, sha256, size_bytes,
                                       mime_type, locked_until)
        values (${id}, ${tenant.tenantId}, ${documentId}, 'pdf', ${key}, ${sha256}, ${data.length},
                'application/pdf', '2037-12-31')`,
    )
    return { id, key, sha256 }
  }

  beforeAll(async () => {
    db = await openTestDb()
    dir = await mkdtemp(join(tmpdir(), 'opc-archive-'))
    files = new FsObjectStore(dir)
    a = await createTenant(db, 'Archiv A')
    b = await createTenant(db, 'Archiv B')
    documentId = await a.run(async (tx) => {
      const { projectId } = await createProject(tx, a.tenantId)
      const { documentId: id } = await createDraftInvoice(tx, a.tenantId, projectId)
      await finalizeDocument(tx, id)
      return id
    })
    await real?.ensureBucket()
  })

  afterAll(async () => {
    await db?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('copies pending originals with retention into the archive, once', async () => {
    const archive = real ?? new MemoryArchive()
    const original = await artifact(a, '%PDF-1.7 Rechnung R-1')
    // Other test files share the database: process everything pending, look at our artifact.
    await archivePending(db.app, files, archive, silent, 500)
    const rows = await a.run(
      (tx) => tx<
        {
          objectKey: string
          mode: string
          retainUntil: Date
          sha256: Buffer
          versionId: string | null
        }[]
      >`
        select object_key as "objectKey", retention_mode as mode, retain_until as "retainUntil",
               sha256, version_id as "versionId"
        from artifact_archive where artifact_id = ${original.id}`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ objectKey: original.key, mode: 'COMPLIANCE' })
    expect(rows[0]?.retainUntil.toISOString()).toBe('2038-01-01T00:00:00.000Z')
    expect(rows[0]?.sha256.equals(original.sha256)).toBe(true)
    expect((await archive.get(original.key))?.toString()).toBe('%PDF-1.7 Rechnung R-1')
    expect(await archive.head(original.key)).toMatchObject({
      sha256: original.sha256.toString('hex'),
      mode: 'COMPLIANCE',
    })
    // Nothing left to do for it; the record is insert-only.
    const pending = await db.app<{ id: string }[]>`select id from pending_archive_artifacts(1000)`
    expect(pending.map((p) => p.id)).not.toContain(original.id)
    await expect(
      a.run((tx) => tx`delete from artifact_archive where artifact_id = ${original.id}`),
    ).rejects.toThrow(/permission denied/)
    // Company B sees neither the record nor the attempt bookkeeping (RLS).
    expect(await b.run((tx) => tx`select 1 from artifact_archive`)).toHaveLength(0)
    expect(await b.run((tx) => tx`select 1 from artifact_archive_attempt`)).toHaveLength(0)
  })

  it('retries failures later and never re-uploads an object that is already there', async () => {
    const archive = new MemoryArchive()
    const original = await artifact(a, '<Invoice>R-2</Invoice>')
    archive.failKeys.add(original.key)
    await archivePending(db.app, files, archive, silent, 1000)
    const [attempt] = await a.run(
      (tx) => tx<{ attempts: number; lastError: string; due: boolean }[]>`
        select attempts, last_error as "lastError", next_attempt_at <= now() as due
        from artifact_archive_attempt where artifact_id = ${original.id}`,
    )
    expect(attempt).toEqual({ attempts: 1, lastError: 'connection refused', due: false })
    // Not due yet: skipped by the next run.
    const pending = await db.app<{ id: string }[]>`select id from pending_archive_artifacts(1000)`
    expect(pending.map((p) => p.id)).not.toContain(original.id)

    // Due again; meanwhile the object reached the bucket (e.g. upload done, record lost): recorded
    // with the existing version instead of a second upload.
    await db.admin`update artifact_archive_attempt set next_attempt_at = now() where artifact_id = ${original.id}`
    archive.failKeys.clear()
    archive.objects.set(original.key, {
      data: Buffer.from('<Invoice>R-2</Invoice>'),
      sha256: original.sha256.toString('hex'),
      retainUntil: new Date('2038-01-01T00:00:00Z'),
    })
    await archivePending(db.app, files, archive, silent, 1000)
    const [record] = await a.run(
      (tx) => tx<{ versionId: string }[]>`
        select version_id as "versionId" from artifact_archive where artifact_id = ${original.id}`,
    )
    expect(record?.versionId).toBe('v-existing')
  })

  it('refuses buckets without Object Lock and modified working copies', async () => {
    const archive = new MemoryArchive()
    archive.lock = false
    const original = await artifact(a, 'Beleg R-3')
    await archivePending(db.app, files, archive, silent, 1000)
    expect(archive.objects.has(original.key)).toBe(false)

    // A working copy that no longer matches its SHA-256 is never archived.
    archive.lock = true
    const pending = await files.receive(Readable.from([Buffer.from('manipuliert')]), {
      maxBytes: 64,
    })
    await rm(join(dir, 'objects', original.key))
    await pending.commit(original.key)
    await archivePending(db.app, files, archive, silent, 1000)
    expect(archive.objects.has(original.key)).toBe(false)
    const [attempt] = await a.run(
      (tx) => tx<{ lastError: string }[]>`
        select last_error as "lastError" from artifact_archive_attempt where artifact_id = ${original.id}`,
    )
    expect(attempt?.lastError).toMatch(/does not match the recorded SHA-256/)
    // The database refuses a record with a different checksum as well.
    await expect(
      a.run(
        (tx) => tx`insert into artifact_archive (artifact_id, tenant_id, bucket, object_key, sha256,
                                                 retain_until, retention_mode)
                   values (${original.id}, ${a.tenantId}, 'b', ${original.key}, ${Buffer.alloc(32)},
                           '2038-01-01', 'COMPLIANCE')`,
      ),
    ).rejects.toThrow(/different SHA-256/)
  })
})
