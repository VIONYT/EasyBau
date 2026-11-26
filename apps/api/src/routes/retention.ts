import type { Tx } from '@easybau/db'
import {
  type PurgeDocumentsResult,
  type PurgeLogEntry,
  purgeDocumentsRequest,
  type RetentionDueDocument,
  type RetentionOverview,
  retentionSettingsRequest,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, parse } from '../http.js'

/**
 * Aufbewahrung (C.12, migration 0047): finalized documents after their retention period. The
 * list is for everyone with `audit.read`; anonymising is an admin decision (`tenant.manage`).
 * The database decides what is due (document_retention_end) and allows nothing else.
 */

const DUE_LIMIT = 500

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

/** Removes the working copies of anonymised originals; the WORM copy is the operator's task. */
async function deleteWorkingCopies(services: Services, auth: AuthContext): Promise<void> {
  const files = await inTenant(
    services,
    auth,
    (tx) => tx<{ artifactId: string; storageKey: string }[]>`
      select artifact_id as "artifactId", storage_key as "storageKey"
      from artifact_purge where file_deleted_at is null order by purged_at limit 1000`,
  )
  const done: string[] = []
  for (const file of files) {
    try {
      await services.storage.delete(file.storageKey)
      done.push(file.artifactId)
    } catch {
      // Stays pending and is retried with the next approval (Löschprotokoll shows it).
    }
  }
  if (done.length) {
    await inTenant(
      services,
      auth,
      (tx) => tx`update artifact_purge set file_deleted_at = now()
                 where artifact_id in ${tx(done)} and file_deleted_at is null`,
    )
  }
}

async function dueDocuments(tx: Tx): Promise<RetentionDueDocument[]> {
  return tx<RetentionDueDocument[]>`
    select d.id, d.type, d.number, to_char(d.document_date, 'YYYY-MM-DD') as "documentDate",
           to_char(e.retention_end, 'YYYY-MM-DD') as "retentionEnd",
           d.recipient_snapshot ->> 'name' as recipient, p.number as "projectNumber",
           (select count(*)::int from document_artifact a where a.document_id = d.id) as originals
    from document d
    join project p on p.id = d.project_id
    cross join lateral (select document_retention_end(d.id) as retention_end) e
    where d.finalized_at is not null and d.purged_at is null
      and e.retention_end < current_date
    order by e.retention_end, d.document_date, d.number
    limit ${DUE_LIMIT + 1}`
}

export function registerRetentionRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/retention', async (request): Promise<RetentionOverview> => {
    const auth = requirePermission(request, 'audit.read')
    return inTenant(services, auth, async (tx) => {
      const [tenant] = await tx<{ retentionYears: number }[]>`
        select retention_years as "retentionYears" from tenant where id = current_tenant_id()`
      const due = await dueDocuments(tx)
      return {
        retentionYears: tenant?.retentionYears ?? 10,
        due: due.slice(0, DUE_LIMIT),
        more: due.length > DUE_LIMIT,
      }
    })
  })

  app.put('/api/v1/settings/retention', async (request) => {
    const auth = requirePermission(request, 'tenant.manage')
    const input = parse(retentionSettingsRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await tx`update tenant set retention_years = ${input.retentionYears} where id = current_tenant_id()`
      return { retentionYears: input.retentionYears }
    })
  })

  // Freigabe: each document in its own transaction (one failure does not stop the others).
  app.post('/api/v1/retention/purge', async (request): Promise<PurgeDocumentsResult> => {
    const auth = requirePermission(request, 'tenant.manage')
    const input = parse(purgeDocumentsRequest, request.body)
    const result: PurgeDocumentsResult = { purged: 0, failed: [] }
    for (const documentId of new Set(input.documentIds)) {
      try {
        const purged = await inTenant(services, auth, async (tx) => {
          const [doc] = await tx<{ purgedAt: string | null }[]>`
            select purged_at as "purgedAt" from document
            where id = ${documentId} and finalized_at is not null for update`
          if (!doc) throw new HttpError(404, 'Beleg nicht gefunden.')
          if (doc.purgedAt) return false
          await tx`
            insert into document_purge (document_id, tenant_id, type, number, document_date,
                                        retention_end, approved_by)
            values (${documentId}, ${auth.tenantId}, '', '', current_date, current_date, ${auth.userId})
            on conflict (document_id) do nothing`
          const [row] = await tx<{ done: boolean }[]>`select purge_document(${documentId}) as done`
          return Boolean(row?.done)
        })
        if (purged) result.purged += 1
      } catch (err) {
        const message =
          err instanceof HttpError
            ? err.message
            : (err as { code?: string }).code === 'P0001'
              ? 'Die Aufbewahrungsfrist ist noch nicht abgelaufen.'
              : 'Der Beleg konnte nicht anonymisiert werden.'
        result.failed.push({ id: documentId, message })
      }
    }
    await deleteWorkingCopies(services, auth)
    return result
  })

  app.get('/api/v1/retention/log', async (request): Promise<PurgeLogEntry[]> => {
    const auth = requirePermission(request, 'audit.read')
    return inTenant(
      services,
      auth,
      (tx) => tx<PurgeLogEntry[]>`
        select p.document_id as "documentId", p.type, p.number,
               to_char(p.document_date, 'YYYY-MM-DD') as "documentDate",
               to_char(p.retention_end, 'YYYY-MM-DD') as "retentionEnd",
               u.display_name as "approvedBy",
               to_char(p.approved_at at time zone 'UTC', ${tx.unsafe(ISO)}) as "approvedAt",
               to_char(p.purged_at at time zone 'UTC', ${tx.unsafe(ISO)}) as "purgedAt",
               count(a.artifact_id)::int as originals,
               count(a.artifact_id) filter (where a.file_deleted_at is null)::int as "filesPending",
               count(a.artifact_id) filter (where a.archived and a.archive_deleted_at is null)::int
                 as "archivePending"
        from document_purge p
        left join app_user u on u.id = p.approved_by
        left join artifact_purge a on a.document_id = p.document_id
        group by p.document_id, u.display_name
        order by p.approved_at desc, p.number
        limit 500`,
    )
  })
}
