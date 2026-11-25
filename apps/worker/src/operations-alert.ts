import { type Sql, type Tx, withTenant } from '@easybau/db'
import {
  alertDecision,
  alertMail,
  type OperationsFacts,
  type OperationsProblem,
  operationsProblems,
} from '@easybau/domain'
import type { Logger } from 'pino'

export interface OperationsAlertOptions {
  /** Without SMTP nobody can be written to; the job then does nothing. */
  smtpEnabled: boolean
  /** WORM archive configured (ARCHIVE_S3_*): only then archive problems count. */
  archiveConfigured: boolean
  appName: string
  now?: () => Date
}

export interface OperationsAlertResult {
  tenantId: string
  problems: OperationsProblem['key'][]
  sent: 'alert' | 'resolved' | null
  recipients: number
}

const iso = (tx: Tx, column: string) =>
  tx.unsafe(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)

/** The facts of the Betriebs-Check that matter for an e-mail, read in the company's context. */
async function factsOf(tx: Tx, now: Date, archiveConfigured: boolean): Promise<OperationsFacts> {
  const [success] = await tx<{ at: string }[]>`
    select ${iso(tx, 'finished_at')} as at from backup_run
    where status = 'ok' order by finished_at desc limit 1`
  const [latest] = await tx<
    {
      status: 'ok' | 'failed'
      finishedAt: string
      message: string | null
      offsiteStatus: 'ok' | 'failed' | 'off' | null
      offsiteMessage: string | null
    }[]
  >`
    select status, ${iso(tx, 'finished_at')} as "finishedAt", message,
           offsite_status as "offsiteStatus", offsite_message as "offsiteMessage"
    from backup_run order by finished_at desc limit 1`
  const [audit] = await tx<{ at: string | null; problem: string | null }[]>`
    select ${iso(tx, 'checked_at')} as at, problem from audit_chain_check
    order by checked_at desc limit 1`
  const [archive] = await tx<
    { failing: number; lastError: string | null; oldest: string | null; lost: number }[]
  >`
    select count(t.artifact_id)::int as failing,
           (array_agg(t.last_error order by t.updated_at desc)
              filter (where t.last_error is not null))[1] as "lastError",
           ${iso(tx, 'min(a.created_at)')} as oldest,
           (select count(*)::int from (
              select distinct on (artifact_id) result from artifact_archive_check
              order by artifact_id, checked_at desc) latest where result = 'lost') as lost
    from document_artifact a
    left join artifact_archive_attempt t on t.artifact_id = a.id
    where not exists (select 1 from artifact_archive r where r.artifact_id = a.id)`
  return {
    now,
    backup: {
      lastSuccessAt: success?.at ?? null,
      latest: latest
        ? {
            status: latest.status,
            finishedAt: latest.finishedAt,
            message: latest.message,
            offsite: latest.offsiteStatus
              ? { status: latest.offsiteStatus, message: latest.offsiteMessage }
              : null,
          }
        : null,
    },
    audit: { lastCheckAt: audit?.at ?? null, problem: audit?.problem ?? null },
    archive: {
      configured: archiveConfigured,
      failing: archive?.failing ?? 0,
      lastError: archive?.lastError ?? null,
      oldestPendingAt: archive?.oldest ?? null,
      lost: archive?.lost ?? 0,
    },
  }
}

/** People who look after the installation: active members whose role may change settings. */
async function recipientsOf(tx: Tx): Promise<string[]> {
  const rows = await tx<{ email: string }[]>`
    select distinct u.email from membership m
    join app_user u on u.id = m.user_id
    join role r on r.id = m.role_id
    where u.is_active and 'settings.write' = any(r.permissions)
      and (m.valid_until is null or m.valid_until >= current_date)
    order by u.email`
  return rows.map((r) => r.email)
}

/**
 * Betriebswarnung per E-Mail: checks every company once (daily job) and queues an e-mail to its
 * administrators when a problem is new, still there after a week, or solved. Idempotent: the
 * last report per company is kept in operations_alert.
 */
export async function alertOperations(
  sql: Sql,
  logger: Pick<Logger, 'info' | 'warn'>,
  options: OperationsAlertOptions,
): Promise<OperationsAlertResult[]> {
  if (!options.smtpEnabled) return []
  const now = (options.now ?? (() => new Date()))()
  const tenants = await sql<{ tenantId: string; name: string }[]>`
    select tenant_id as "tenantId", name from operations_alert_tenants()`
  const results: OperationsAlertResult[] = []
  for (const tenant of tenants) {
    const result = await withTenant(
      sql,
      { tenantId: tenant.tenantId },
      async (tx): Promise<OperationsAlertResult> => {
        const problems = operationsProblems(await factsOf(tx, now, options.archiveConfigured))
        const [previous] = await tx<{ problems: string[]; sentAt: string }[]>`
        select problems, ${iso(tx, 'sent_at')} as "sentAt" from operations_alert`
        const decision = alertDecision(previous ?? null, problems, now)
        const keys = problems.map((p) => p.key)
        let recipients = 0
        if (decision) {
          const [company] = await tx<{ email: string | null }[]>`
          select email from tenant where id = current_tenant_id()`
          const mail = alertMail(decision, {
            appName: options.appName,
            company: tenant.name,
            problems,
          })
          for (const to of await recipientsOf(tx)) {
            await tx`
            insert into email_message (tenant_id, kind, to_address, reply_to, subject, body_text)
            values (${tenant.tenantId}, 'operations_alert', ${to}, ${company?.email ?? null},
                    ${mail.subject}, ${mail.text})`
            recipients += 1
          }
          await tx`
          insert into operations_alert (tenant_id, problems, sent_at)
          values (${tenant.tenantId}, ${keys}::text[], ${now.toISOString()})
          on conflict (tenant_id) do update set problems = excluded.problems, sent_at = excluded.sent_at`
        }
        return { tenantId: tenant.tenantId, problems: keys, sent: decision, recipients }
      },
    )
    if (result.sent && result.recipients === 0) {
      logger.warn({ tenantId: tenant.tenantId }, 'operations alert without recipients')
    }
    results.push(result)
  }
  logger.info(
    { companies: results.length, sent: results.filter((r) => r.sent).length },
    'operations alert checked',
  )
  return results
}
