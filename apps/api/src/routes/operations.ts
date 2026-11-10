import type { BackupRunSummary, OperationsStatus } from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { inTenant, requirePermission, type Services } from '../context.js'

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
      return {
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
      }
    })
  })
}
