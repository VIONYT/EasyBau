import type { Tx } from '@easybau/db'
import type { BackupRunSummary, OperationsStatus } from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError } from '../http.js'
import { kositHealthy } from '../kosit.js'
import { auditChainStatus } from './audit.js'

/** Betriebs-Check: backup log (written by the backup service, ADR 0005), e-mail, security. */
const ISO = (tx: Tx, expression: string) =>
  tx.unsafe(`to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)

export function registerOperationsRoutes(app: FastifyInstance, services: Services) {
  // Archiv-Abgleich: check every archived original of the company now (worker, in steps).
  app.post('/api/v1/settings/operations/archive-verify', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    if (!services.archive) {
      throw new HttpError(409, 'Es ist kein Belegarchiv eingerichtet (ARCHIVE_S3_ENDPOINT).')
    }
    const created = await inTenant(
      services,
      auth,
      (tx) => tx`
        insert into archive_verify_request (tenant_id, reason, requested_by)
        values (${auth.tenantId}, 'manual', ${auth.userId})
        on conflict (tenant_id) where finished_at is null do nothing`,
    )
    if (!created.count) throw new HttpError(409, 'Ein Abgleich des Belegarchivs läuft bereits.')
    return reply.status(202).send({ queued: true })
  })

  app.get('/api/v1/settings/operations', async (request): Promise<OperationsStatus> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, async (tx) => {
      const select = (where: 'all' | 'ok') => tx<BackupRunSummary[]>`
        select name, status, started_at as "startedAt", finished_at as "finishedAt",
               db_bytes::float8 as "dbBytes", files_bytes::float8 as "filesBytes", message,
               case when offsite_status is null then null else json_build_object(
                 'status', offsite_status,
                 'at', to_char(offsite_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'target', offsite_target, 'message', offsite_message) end as offsite
        from backup_run ${where === 'ok' ? tx`where status = 'ok'` : tx``}
        order by finished_at desc limit ${where === 'ok' ? 1 : 10}`
      const [lastSuccess] = await select('ok')
      const recent = await select('all')
      const [mail] = await tx<{ queued: number; failed: number }[]>`
        select count(*) filter (where status in ('queued', 'sending'))::int as queued,
               count(*) filter (where status = 'failed')::int as failed
        from email_message`
      const [pending] = await tx<
        { pending: number; oldest: string | null; failing: number; lastError: string | null }[]
      >`
        select count(*)::int as pending,
               to_char(min(a.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as oldest,
               count(t.artifact_id)::int as failing,
               (array_agg(t.last_error order by t.updated_at desc) filter (where t.last_error is not null))[1]
                 as "lastError"
        from document_artifact a
        left join artifact_archive_attempt t on t.artifact_id = a.id
        where not exists (select 1 from artifact_archive r where r.artifact_id = a.id)`
      const archiveStatus = services.archive ? await services.archive.status() : null
      const [verify] = await tx<
        {
          lastCheckAt: string | null
          checked: number
          restored: number
          lost: number
          unchecked: number
        }[]
      >`
        select ${ISO(tx, '(select max(checked_at) from artifact_archive_check)')} as "lastCheckAt",
               (select count(*)::int from artifact_archive_check where checked_at > now() - interval '30 days') as checked,
               (select count(*)::int from artifact_archive_check
                where checked_at > now() - interval '30 days' and result = 'restored') as restored,
               (select count(*)::int from (
                  select distinct on (artifact_id) result from artifact_archive_check
                  order by artifact_id, checked_at desc) latest where result = 'lost') as lost,
               (select count(*)::int from artifact_archive r
                where not exists (select 1 from artifact_archive_check c where c.artifact_id = r.artifact_id)) as unchecked`
      const [request] = await tx<
        {
          reason: 'manual' | 'restore' | 'move'
          requestedAt: string
          startedAt: string | null
          finishedAt: string | null
          checked: number
          restored: number
          lost: number
        }[]
      >`
        select reason, ${ISO(tx, 'requested_at')} as "requestedAt", ${ISO(tx, 'started_at')} as "startedAt",
               ${ISO(tx, 'finished_at')} as "finishedAt", checked, restored, lost
        from archive_verify_request
        where finished_at is null or finished_at > now() - interval '7 days'
        order by requested_at desc limit 1`
      const audit = await auditChainStatus(tx)
      return {
        audit: {
          lastCheckAt: audit.last?.checkedAt ?? null,
          problem: audit.last?.problem ?? null,
          brokenSeq: audit.last?.brokenSeq ?? null,
          events: audit.last?.events ?? 0,
          stale: audit.stale,
        },
        archive: {
          configured: services.archive !== null,
          bucket: services.archive?.bucket ?? null,
          reachable: archiveStatus?.reachable ?? false,
          objectLock: archiveStatus?.objectLock ?? false,
          mode: services.archive?.mode ?? null,
          pending: pending?.pending ?? 0,
          oldestPendingAt: pending?.oldest ?? null,
          failing: pending?.failing ?? 0,
          lastError: pending?.lastError ?? null,
          verify: {
            lastCheckAt: verify?.lastCheckAt ?? null,
            checked30d: verify?.checked ?? 0,
            restored30d: verify?.restored ?? 0,
            lost: verify?.lost ?? 0,
            unchecked: verify?.unchecked ?? 0,
            request: request ?? null,
          },
        },
        backup: { lastSuccess: lastSuccess ?? null, recent },
        email: {
          enabled: services.config.SMTP_ENABLED,
          queued: mail?.queued ?? 0,
          failed: mail?.failed ?? 0,
        },
        security: {
          requireAdminMfa: services.config.REQUIRE_ADMIN_MFA,
          https: (services.config.PUBLIC_URL ?? 'https://').startsWith('https://'),
        },
        einvoice: {
          configured: services.einvoiceValidator !== null,
          reachable: services.config.KOSIT_URL
            ? await kositHealthy(services.config.KOSIT_URL)
            : services.einvoiceValidator !== null,
        },
      }
    })
  })
}
