import { createHash } from 'node:crypto'
import { type Sql, withTenant } from '@easybau/db'
import { type ArchiveStore, type ObjectStore, retainUntilOf } from '@easybau/storage'
import type { Logger } from 'pino'
import { isoDate, readAll } from './files.js'

interface PendingArtifact {
  id: string
  tenant_id: string
  storage_key: string
  sha256: Buffer
  size_bytes: string
  mime_type: string
  locked_until: Date | string
}

export interface ArchiveRun {
  archived: number
  failed: number
}

/**
 * Copies pending document originals (all companies) into the WORM archive (ADR 0008). Idempotent:
 * an object with the same SHA-256 already in the bucket is recorded instead of uploaded again.
 * Never writes into a bucket without Object Lock. Failures are retried later with growing pauses.
 */
export async function archivePending(
  sql: Sql,
  files: ObjectStore,
  archive: ArchiveStore,
  logger: Pick<Logger, 'warn' | 'info' | 'debug'>,
  limit = 20,
): Promise<ArchiveRun> {
  const rows = await sql<PendingArtifact[]>`select * from pending_archive_artifacts(${limit})`
  const run: ArchiveRun = { archived: 0, failed: 0 }
  if (!rows.length) return run
  const status = await archive.status()
  if (!status.objectLock) {
    logger.warn(
      { bucket: archive.bucket, reachable: status.reachable, error: status.error },
      'archive bucket missing or without Object Lock; nothing archived',
    )
    return run
  }
  for (const row of rows) {
    try {
      const data = await readAll(files, row.storage_key)
      const sha256 = createHash('sha256').update(data).digest()
      if (!sha256.equals(row.sha256)) {
        throw new Error('working copy does not match the recorded SHA-256')
      }
      const retainUntil = retainUntilOf(isoDate(row.locked_until))
      const existing = await archive.head(row.storage_key)
      const versionId =
        existing?.sha256 === sha256.toString('hex')
          ? existing.versionId
          : (
              await archive.put(row.storage_key, data, {
                sha256,
                contentType: row.mime_type,
                retainUntil,
              })
            ).versionId
      await withTenant(
        sql,
        { tenantId: row.tenant_id },
        (tx) =>
          tx`insert into artifact_archive (artifact_id, tenant_id, bucket, object_key, version_id, sha256,
                                         retain_until, retention_mode)
           values (${row.id}, ${row.tenant_id}, ${archive.bucket}, ${row.storage_key}, ${versionId},
                   ${sha256}, ${retainUntil.toISOString()}::timestamptz, ${archive.mode})
           on conflict (artifact_id) do nothing`,
      )
      run.archived += 1
    } catch (error) {
      run.failed += 1
      const message = (error as Error).message ?? String(error)
      logger.warn({ artifact: row.id, err: message }, 'archiving failed, retrying later')
      await sql`select archive_attempt_failed(${row.id}, ${message})`
    }
  }
  if (run.archived) logger.info({ archived: run.archived }, 'documents archived (WORM)')
  return run
}
