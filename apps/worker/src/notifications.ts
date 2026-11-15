import type { Sql } from '@opc/db'
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
  logger.info({ removed, days }, 'read notifications purged')
  return removed
}
