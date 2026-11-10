import type { BackupRunSummary, OperationsStatus } from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { inTenant, requirePermission, type Services } from '../context.js'
import { kositHealthy } from '../kosit.js'

/** Betriebs-Check: backup log (written by the backup service, ADR 0005), e-mail, security. */
export function registerOperationsRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/settings/operations', async (request): Promise<OperationsStatus> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, async (tx) => {
      const select = (where: 'all' | 'ok') => tx<BackupRunSummary[]>`
        select name, status, started_at as "startedAt", finished_at as "finishedAt",
               db_bytes::float8 as "dbBytes", files_bytes::float8 as "filesBytes", message
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
      return {
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
