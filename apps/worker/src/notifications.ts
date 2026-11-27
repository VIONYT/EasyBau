import type { Sql } from '@easybau/db'
import type { Logger } from 'pino'

/** Read notifications older than this are deleted (they are only hints with a link). */
export const NOTIFICATION_RETENTION_DAYS = 90

/**
 * Benachrichtigungen aufräumen: deletes read notifications after 90 days for all companies
 * (except "Rechnung überfällig", see migration 0036). Idempotent.
 */
export async function purgeReadNotifications(
  sql: Sql,
  logger: Pick<Logger, 'info'>,
  days = NOTIFICATION_RETENTION_DAYS,
): Promise<number> {
  const [row] = await sql<{ removed: number }[]>`
    select purge_read_notifications(${days}) as removed`
  const removed = row?.removed ?? 0
  // Rate-limit windows are at most a day long; old rows (one per person and day for the
  // overdue check) are only clutter.
  const stale = await sql`delete from rate_limit where window_start < now() - interval '2 days'`
  // Protokoll je E-Mail im Rechnungseingang: sender addresses are personal data, 90 days.
  const [mails] = await sql<{ removed: number }[]>`
    select purge_incoming_mail_log(${days}) as removed`
  logger.info(
    { removed, days, staleRateLimits: stale.count, mailLog: mails?.removed ?? 0 },
    'read notifications purged',
  )
  return removed
}
