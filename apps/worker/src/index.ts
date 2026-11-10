import { type Config, smtpEnabled } from '@opc/config'
import { createSql } from '@opc/db'
import { PgBoss } from 'pg-boss'
import type { Logger } from 'pino'
import { dispatchEmails, smtpTransport } from './email.js'

export { dispatchEmails, type MailTransport, type OutgoingMail, smtpTransport } from './email.js'

/**
 * Background jobs run on pg-boss, i.e. inside PostgreSQL (ADR 0002).
 * Rule: jobs are enqueued in the same transaction as the change that triggers them
 * and every handler must be idempotent.
 */
export const queues = {
  heartbeat: 'system.heartbeat',
} as const

export interface Worker {
  stop: () => Promise<void>
}

export async function startWorker(
  config: Pick<
    Config,
    | 'DATABASE_URL'
    | 'DATABASE_POOL_MAX'
    | 'PROFILE'
    | 'SMTP_HOST'
    | 'SMTP_PORT'
    | 'SMTP_SECURE'
    | 'SMTP_USER'
    | 'SMTP_PASSWORD'
    | 'SMTP_FROM'
  >,
  logger: Logger,
): Promise<Worker> {
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: 'jobs',
    // Keep the footprint small in the compact profile.
    max: config.PROFILE === 'compact' ? 2 : 5,
  })
  boss.on('error', (err) => logger.error({ err }, 'job queue error'))

  await boss.start()
  await boss.createQueue(queues.heartbeat)
  await boss.work(queues.heartbeat, async ([job]) => {
    logger.debug({ jobId: job?.id }, 'heartbeat')
  })
  // Proves the scheduler works end to end; replaced by real maintenance jobs later.
  await boss.schedule(queues.heartbeat, '*/15 * * * *')
  // E-mail outbox (optional): polled every 15 s, cheap thanks to a partial index.
  let mailTimer: NodeJS.Timeout | undefined
  const sql = smtpEnabled(config) ? createSql({ ...config, DATABASE_POOL_MAX: 1 }) : undefined
  if (sql) {
    const transport = smtpTransport(config)
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        await dispatchEmails(sql, transport, config.SMTP_FROM as string, logger)
      } catch (err) {
        logger.error({ err }, 'e-mail dispatch failed')
      } finally {
        running = false
      }
    }
    mailTimer = setInterval(tick, 15_000)
    void tick()
    logger.info('e-mail sending enabled')
  }
  logger.info('worker started')

  return {
    stop: async () => {
      if (mailTimer) clearInterval(mailTimer)
      await boss.stop({ graceful: true, timeout: 10_000 })
      await sql?.end({ timeout: 5 })
      logger.info('worker stopped')
    },
  }
}
