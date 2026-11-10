import { type Config, smtpEnabled } from '@opc/config'
import { createSql } from '@opc/db'
import { archiveStoreFromSettings, FsObjectStore } from '@opc/storage'
import { PgBoss } from 'pg-boss'
import type { Logger } from 'pino'
import { archivePending } from './archive.js'
import { dispatchEmails, smtpTransport } from './email.js'

export { type ArchiveRun, archivePending } from './archive.js'

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
    | 'STORAGE_DIR'
    | 'ARCHIVE_S3_ENDPOINT'
    | 'ARCHIVE_S3_REGION'
    | 'ARCHIVE_S3_BUCKET'
    | 'ARCHIVE_S3_ACCESS_KEY'
    | 'ARCHIVE_S3_SECRET_KEY'
    | 'ARCHIVE_S3_PATH_STYLE'
    | 'ARCHIVE_S3_CREATE_BUCKET'
    | 'ARCHIVE_RETENTION_MODE'
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
  // Belegarchiv (ADR 0008): copy finalized originals into the WORM bucket, every 30 s.
  let archiveTimer: NodeJS.Timeout | undefined
  const archive = archiveStoreFromSettings(config)
  const archiveSql = archive ? createSql({ ...config, DATABASE_POOL_MAX: 1 }) : undefined
  if (archive && archiveSql) {
    const files = new FsObjectStore(config.STORAGE_DIR)
    let bucketReady = !config.ARCHIVE_S3_CREATE_BUCKET
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        if (!bucketReady) {
          await archive.ensureBucket()
          bucketReady = true
          logger.info({ bucket: archive.bucket }, 'archive bucket with Object Lock ready')
        }
        await archivePending(archiveSql, files, archive, logger)
      } catch (err) {
        logger.error({ err }, 'archiving failed')
      } finally {
        running = false
      }
    }
    archiveTimer = setInterval(tick, 30_000)
    void tick()
    logger.info({ bucket: archive.bucket, mode: archive.mode }, 'document archive enabled')
  } else {
    logger.warn(
      'no document archive configured (ARCHIVE_S3_ENDPOINT): originals stay in the files volume only',
    )
  }
  logger.info('worker started')

  return {
    stop: async () => {
      if (mailTimer) clearInterval(mailTimer)
      if (archiveTimer) clearInterval(archiveTimer)
      await boss.stop({ graceful: true, timeout: 10_000 })
      await sql?.end({ timeout: 5 })
      await archiveSql?.end({ timeout: 5 })
      logger.info('worker stopped')
    },
  }
}
