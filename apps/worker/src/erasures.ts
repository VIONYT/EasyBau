import { createHash } from 'node:crypto'
import { deletePurgedWorkingCopies, type Sql, withTenant } from '@easybau/db'
import type { ArchiveStore, ObjectStore } from '@easybau/storage'
import type { Logger } from 'pino'

/**
 * Löschmarken (migration 0052): every anonymised document and erased contact leaves a marker in
 * the WORM archive. An older backup brings both back; after a restore (worker start) and every
 * night the worker repeats what the restored database lost – before the archive reconciliation
 * could write anonymised originals back.
 */

const PREFIX = 'erasures/'
const KEY = /^erasures\/([0-9a-f-]{36})\/(document|contact)\/([0-9a-f-]{36})\.json$/

/** Markers are kept at least as long as any document (10 years); the app can never delete them. */
const MARKER_RETAIN_YEARS = 10

type Kind = 'document' | 'contact'

interface Marker {
  tenantId: string
  kind: Kind
  refId: string
  approvedBy?: string | null
  approvedAt?: string | null
}

export const markerKey = (tenantId: string, kind: Kind, refId: string) =>
  `${PREFIX}${tenantId}/${kind}/${refId}.json`

/** Writes markers not yet in the archive. Never into a bucket without Object Lock. */
export async function writeErasureMarkers(
  sql: Sql,
  archive: ArchiveStore,
  logger: Pick<Logger, 'warn' | 'info'>,
  limit = 50,
): Promise<number> {
  const rows = await sql<
    { tenant_id: string; kind: Kind; ref_id: string; payload: Record<string, unknown> }[]
  >`select * from pending_erasure_markers(${limit})`
  if (!rows.length) return 0
  if (!(await archive.status()).objectLock) {
    logger.warn({ bucket: archive.bucket }, 'archive without Object Lock; erasure markers wait')
    return 0
  }
  const retainUntil = new Date()
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + MARKER_RETAIN_YEARS)
  let written = 0
  for (const row of rows) {
    const key = markerKey(row.tenant_id, row.kind, row.ref_id)
    try {
      if (!(await archive.head(key))) {
        const data = Buffer.from(
          JSON.stringify({
            ...row.payload,
            tenantId: row.tenant_id,
            kind: row.kind,
            refId: row.ref_id,
          }),
        )
        await archive.put(key, data, {
          sha256: createHash('sha256').update(data).digest(),
          contentType: 'application/json',
          retainUntil,
        })
      }
      await sql`select erasure_marker_written(${row.kind}, ${row.ref_id})`
      written += 1
    } catch (err) {
      logger.warn(
        { key, err: (err as Error).message },
        'erasure marker not written, retrying later',
      )
    }
  }
  return written
}

export interface ReapplyRun {
  documents: number
  contacts: number
  failed: number
}

/** Repeats anonymisations and erasures the database no longer knows about (after a restore). */
export async function reapplyErasures(
  sql: Sql,
  files: ObjectStore,
  archive: ArchiveStore,
  logger: Pick<Logger, 'warn' | 'info' | 'error'>,
): Promise<ReapplyRun> {
  const run: ReapplyRun = { documents: 0, contacts: 0, failed: 0 }
  const marked = (await archive.list(PREFIX)).flatMap((key) => {
    const match = KEY.exec(key)
    return match ? [{ kind: match[2] as Kind, refId: match[3] as string }] : []
  })
  if (!marked.length) return run
  const due = await sql<{ tenant_id: string; kind: Kind; ref_id: string }[]>`
    select * from erasures_to_reapply(${marked.map((m) => m.kind)}::text[],
                                      ${marked.map((m) => m.refId)}::uuid[])`
  const tenants = new Set<string>()
  for (const row of due) {
    try {
      const raw = await archive.get(markerKey(row.tenant_id, row.kind, row.ref_id))
      const marker = raw ? (JSON.parse(raw.toString('utf8')) as Marker) : null
      if (!marker || marker.tenantId !== row.tenant_id || marker.refId !== row.ref_id) {
        throw new Error('marker missing or not matching')
      }
      await withTenant(sql, { tenantId: row.tenant_id }, async (tx) => {
        if (row.kind === 'contact') {
          await tx`select erase_contact(${row.ref_id})`
          return
        }
        // The approval as given back then (the guard fills number and retention end itself).
        await tx`
          insert into document_purge (document_id, tenant_id, type, number, document_date,
                                      retention_end, approved_by, approved_at)
          values (${row.ref_id}, ${row.tenant_id}, '', '', current_date, current_date,
                  ${marker.approvedBy ?? null}, coalesce(${marker.approvedAt ?? null}::timestamptz, now()))
          on conflict (document_id) do nothing`
        await tx`select purge_document(${row.ref_id})`
      })
      if (row.kind === 'contact') run.contacts += 1
      else run.documents += 1
      tenants.add(row.tenant_id)
    } catch (err) {
      run.failed += 1
      logger.error(
        { kind: row.kind, id: row.ref_id, err: (err as Error).message },
        'erasure after restore could not be repeated; repeat it by hand (Prüfung › Aufbewahrung)',
      )
    }
  }
  for (const tenantId of tenants) await deletePurgedWorkingCopies(sql, { tenantId }, files)
  if (run.documents || run.contacts) {
    logger.info({ ...run }, 'erasures repeated after restore')
  }
  return run
}
