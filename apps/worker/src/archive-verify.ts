import { createHash } from 'node:crypto'
import { type Sql, withTenant } from '@easybau/db'
import { type ArchiveStore, type ObjectStore, retainUntilOf } from '@easybau/storage'
import type { Logger } from 'pino'

interface Candidate {
  id: string
  tenant_id: string
  storage_key: string
  sha256: Buffer
  size_bytes: string
  mime_type: string
  locked_until: Date | string
}

export type ArchiveProblem = 'missing' | 'sha256' | 'size' | 'retention' | 'content'

export interface VerifyRun {
  checked: number
  ok: number
  restored: number
  lost: number
}

export interface VerifyOptions {
  /** Objects per run. */
  limit: number
  /** Every n-th object is downloaded and hashed (content check); 1 = all. */
  deepEvery: number
  /** Only this company (complete reconciliation on request). */
  tenantId?: string
  /** Only objects not checked since this moment. */
  before?: Date
}

const isoDate = (value: Date | string) =>
  typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10)
const sha256Of = (data: Buffer) => createHash('sha256').update(data).digest()

async function readWorkingCopy(files: ObjectStore, key: string): Promise<Buffer | null> {
  if ((await files.size(key)) === null) return null
  const chunks: Buffer[] = []
  for await (const chunk of files.read(key)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * Archiv-Abgleich (ADR 0008): checks archived originals in the WORM bucket. HEAD for every object
 * (exists, SHA-256 metadata, size, Object Lock until the end of the retention period), the content
 * of every n-th. A missing or damaged object is written again (new version, same retention) from
 * the working copy or – while moving to another S3 – from the previous archive, but only if the
 * source matches the SHA-256 recorded at finalizing. Every check is recorded.
 */
export async function verifyArchive(
  sql: Sql,
  files: ObjectStore,
  archive: ArchiveStore,
  previous: Pick<ArchiveStore, 'get' | 'bucket'> | null,
  logger: Pick<Logger, 'warn' | 'info' | 'error'>,
  options: VerifyOptions,
): Promise<VerifyRun> {
  const run: VerifyRun = { checked: 0, ok: 0, restored: 0, lost: 0 }
  const status = await archive.status()
  if (!status.objectLock) {
    logger.warn(
      { bucket: archive.bucket, reachable: status.reachable, error: status.error },
      'archive bucket missing or without Object Lock; reconciliation skipped',
    )
    return run
  }
  const rows = await sql<Candidate[]>`
    select * from archive_verify_candidates(${options.limit}, ${options.tenantId ?? null},
                                            ${options.before?.toISOString() ?? null}::timestamptz)`
  for (const [index, row] of rows.entries()) {
    const expected = row.sha256.toString('hex')
    const retainUntil = retainUntilOf(isoDate(row.locked_until))
    const deep = index % Math.max(1, options.deepEvery) === 0
    let problem: ArchiveProblem | null = null
    try {
      const head = await archive.head(row.storage_key)
      if (!head) problem = 'missing'
      else if (head.sha256 !== expected) problem = 'sha256'
      else if (head.sizeBytes !== Number(row.size_bytes)) problem = 'size'
      else if (!head.retainUntil || Date.parse(head.retainUntil) < retainUntil.getTime() - 1000)
        problem = 'retention'
      else if (deep) {
        const data = await archive.get(row.storage_key)
        if (!data || !sha256Of(data).equals(row.sha256)) problem = 'content'
      }
      let result: 'ok' | 'restored' | 'lost' = 'ok'
      let source: 'working_copy' | 'previous_archive' | null = null
      let versionId: string | null = null
      if (problem) {
        const intact = (data: Buffer | null) =>
          data && sha256Of(data).equals(row.sha256) ? data : null
        let data = intact(await readWorkingCopy(files, row.storage_key))
        source = data ? 'working_copy' : null
        if (!data && previous) {
          data = intact(await previous.get(row.storage_key))
          source = data ? 'previous_archive' : null
        }
        if (data) {
          versionId = (
            await archive.put(row.storage_key, data, {
              sha256: row.sha256,
              contentType: row.mime_type,
              retainUntil,
            })
          ).versionId
          result = 'restored'
        } else {
          result = 'lost'
          source = null
        }
      }
      await withTenant(
        sql,
        { tenantId: row.tenant_id },
        (tx) => tx`
          insert into artifact_archive_check (artifact_id, tenant_id, bucket, deep, result, problem,
                                              source, version_id)
          values (${row.id}, ${row.tenant_id}, ${archive.bucket}, ${deep && (problem === null || problem === 'content')},
                  ${result}, ${problem}, ${source}, ${versionId})`,
      )
      run.checked += 1
      run[result] += 1
      if (result === 'restored') {
        logger.warn({ artifact: row.id, problem, source }, 'archived original restored')
      } else if (result === 'lost') {
        // An original is neither in the archive nor in an intact copy: needs a person.
        logger.error(
          { artifact: row.id, problem },
          'archived original missing or damaged, no intact copy',
        )
      }
    } catch (error) {
      // Archive not reachable mid-run etc.: try again next time, no result recorded.
      logger.warn({ artifact: row.id, err: (error as Error).message }, 'archive check failed')
    }
  }
  if (run.checked) logger.info({ ...run }, 'archive reconciliation')
  return run
}

/**
 * Works on the oldest open complete reconciliation (after a restore or on request) in steps of
 * `limit` objects; finishes it when every object of the company was checked since it started.
 */
export async function verifyRequested(
  sql: Sql,
  files: ObjectStore,
  archive: ArchiveStore,
  previous: Pick<ArchiveStore, 'get' | 'bucket'> | null,
  logger: Pick<Logger, 'warn' | 'info' | 'error'>,
  limit = 200,
): Promise<VerifyRun | null> {
  const [request] = await sql<{ id: string; tenant_id: string; started_at: Date }[]>`
    select * from next_archive_verify_request()`
  if (!request) return null
  const run = await verifyArchive(sql, files, archive, previous, logger, {
    limit,
    deepEvery: 10,
    tenantId: request.tenant_id,
    before: new Date(request.started_at),
  })
  const [left] = await sql<{ n: number }[]>`
    select count(*)::int as n from archive_verify_candidates(1, ${request.tenant_id},
                                                             ${new Date(request.started_at).toISOString()}::timestamptz)`
  const done = (left?.n ?? 0) === 0
  await withTenant(
    sql,
    { tenantId: request.tenant_id },
    (tx) => tx`
      update archive_verify_request set checked = checked + ${run.checked},
             restored = restored + ${run.restored}, lost = lost + ${run.lost},
             finished_at = ${done ? tx`now()` : tx`null`}
      where id = ${request.id}`,
  )
  if (done) logger.info({ request: request.id }, 'complete archive reconciliation finished')
  return run
}
