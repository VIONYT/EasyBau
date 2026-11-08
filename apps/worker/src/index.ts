import type { Config } from '@opc/config'
import { PgBoss } from 'pg-boss'
import type { Logger } from 'pino'

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
  config: Pick<Config, 'DATABASE_URL' | 'PROFILE'>,
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
  logger.info('worker started')

  return {
    stop: async () => {
      await boss.stop({ graceful: true, timeout: 10_000 })
      logger.info('worker stopped')
    },
  }
}
