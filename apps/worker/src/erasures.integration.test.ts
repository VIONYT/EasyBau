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
import { FsObjectStore, MemoryArchiveStore } from '@easybau/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { archivePending } from './archive.js'
import { verifyArchive } from './archive-verify.js'
import { markerKey, reapplyErasures, writeErasureMarkers } from './erasures.js'

const silent = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest()

/**
 * Löschmarken (migration 0052): a backup from before an anonymisation or erasure brings the data
 * back; the worker repeats the erasure from the marker in the WORM archive, and the archive
 * reconciliation does not write the anonymised original back.
 */
describe.skipIf(!testDatabaseUrl)('Löschungen nach Wiederherstellung (integration)', () => {
  let db: TestDb
  let dir: string
  let files: FsObjectStore
  let tenant: TestTenant
  const archive = new MemoryArchiveStore()

  beforeAll(async () => {
    db = await openTestDb({ isolated: true })
    dir = await mkdtemp(join(tmpdir(), 'erasures-'))
    files = new FsObjectStore(dir)
    tenant = await createTenant(db, 'Wiederhergestellt')
  })
  afterAll(async () => {
    await db?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function storeFile(key: string, data: Buffer) {
    const pending = await files.receive(Readable.from([data]), { maxBytes: 1024 })
    await pending.commit(key)
  }

  it('repeats anonymisations and erasures that a restored backup brought back', async () => {
    // A finalized invoice from 2010 (retention over) with an archived original, and a customer.
    const { documentId, contactId } = await tenant.run(async (tx) => {
      const { projectId } = await createProject(tx, tenant.tenantId)
      const [person] = await tx<{ id: string }[]>`
        insert into contact (tenant_id, kind, first_name, last_name)
        values (${tenant.tenantId}, 'person', 'Erna', 'Muster') returning id`
      const { documentId } = await createDraftInvoice(tx, tenant.tenantId, projectId)
      await finalizeDocument(tx, documentId)
      return { documentId, contactId: person?.id as string }
    })
    const original = Buffer.from('%PDF-1.7 Rechnung 2010')
    const artifactKey = `${tenant.tenantId}/documents/${documentId}/${randomUUID()}`
    await storeFile(artifactKey, original)
    await db.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`update document set document_date = '2010-03-01', finalized_at = '2010-03-01'
               where id = ${documentId}`
      await tx`
        insert into document_artifact (tenant_id, document_id, kind, storage_key, sha256, size_bytes,
                                       mime_type, locked_until)
        values (${tenant.tenantId}, ${documentId}, 'pdf', ${artifactKey}, ${sha(original)},
                ${original.length}, 'application/pdf', '2020-12-31')`
    })
    expect((await archivePending(db.app, files, archive, silent)).archived).toBe(1)

    // Anonymise (as the API does after approval) and erase the contact.
    await tenant.run(async (tx) => {
      await tx`
        insert into document_purge (document_id, tenant_id, type, number, document_date,
                                    retention_end, approved_by)
        values (${documentId}, ${tenant.tenantId}, '', '', current_date, current_date, ${tenant.userId})`
      await tx`select purge_document(${documentId})`
      await tx`select erase_contact(${contactId})`
    })
    await files.delete(artifactKey)
    expect(await writeErasureMarkers(db.app, archive, silent)).toBe(2)
    expect(await writeErasureMarkers(db.app, archive, silent)).toBe(0)
    const marker = JSON.parse(
      (await archive.get(markerKey(tenant.tenantId, 'document', documentId)))?.toString() ?? '{}',
    )
    expect(marker).toMatchObject({ refId: documentId, approvedBy: tenant.userId })
    // The operator removed the WORM copy (infra/archive-purge.sh).
    archive.objects.delete(artifactKey)

    // Restore of a backup from before: the data is back, the working copy too, no markers.
    await db.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`
      await tx`delete from artifact_purge where document_id = ${documentId}`
      await tx`delete from document_purge where document_id = ${documentId}`
      await tx`update document set purged_at = null, subject = 'Fliesenarbeiten' where id = ${documentId}`
      await tx`update contact set erased_at = null, first_name = 'Erna', last_name = 'Muster'
               where id = ${contactId}`
      await tx`delete from erasure_marker`
    })
    await storeFile(artifactKey, original)

    expect(await reapplyErasures(db.app, files, archive, silent)).toEqual({
      documents: 1,
      contacts: 1,
      failed: 0,
    })
    const [state] = await tenant.run(
      (tx) => tx<{ purged: boolean; subject: string | null; erased: boolean; lastName: string }[]>`
        select d.purged_at is not null as purged, d.subject, c.erased_at is not null as erased,
               c.last_name as "lastName"
        from document d, contact c where d.id = ${documentId} and c.id = ${contactId}`,
    )
    expect(state).toEqual({
      purged: true,
      subject: null,
      erased: true,
      lastName: 'Gelöschter Kontakt',
    })
    expect(await files.size(artifactKey)).toBeNull()
    // Nothing writes the anonymised original back into the archive.
    await archivePending(db.app, files, archive, silent)
    await verifyArchive(db.app, files, archive, null, silent, { limit: 50, deepEvery: 1 })
    expect(archive.objects.has(artifactKey)).toBe(false)
    // Idempotent; the markers stay in the archive (the restored database wrote them again).
    expect(await reapplyErasures(db.app, files, archive, silent)).toEqual({
      documents: 0,
      contacts: 0,
      failed: 0,
    })
    expect(await writeErasureMarkers(db.app, archive, silent)).toBe(2)
    expect(archive.versions.get(markerKey(tenant.tenantId, 'contact', contactId))).toHaveLength(1)
  })

  it('keeps markers away from other companies and from direct changes', async () => {
    const other = await createTenant(db, 'Andere')
    expect(await other.run((tx) => tx`select * from erasure_marker`)).toEqual([])
    expect((await tenant.run((tx) => tx`select * from erasure_marker`)).length).toBeGreaterThan(0)
    await expect(tenant.run((tx) => tx`delete from erasure_marker`)).rejects.toThrow(
      /permission denied/,
    )
    await expect(
      tenant.run((tx) => tx`update erasure_marker set written_at = null`),
    ).rejects.toThrow(/permission denied/)
  })
})
