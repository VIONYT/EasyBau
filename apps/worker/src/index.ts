import { type Config, smtpEnabled } from '@opc/config'
import { createSql } from '@opc/db'
import { archiveStoreFromSettings, FsObjectStore, previousArchiveFromSettings } from '@opc/storage'
import { PgBoss } from 'pg-boss'
import type { Logger } from 'pino'
import { archivePending } from './archive.js'
import { verifyArchive, verifyRequested } from './archive-verify.js'
import { checkAuditChains } from './audit.js'
import { dispatchEmails, smtpTransport } from './email.js'
import { purgeReadNotifications } from './notifications.js'
import { alertOperations } from './operations-alert.js'

export { eraseExpiredContacts } from './privacy.js'

import { eraseExpiredContacts } from './privacy.js'

export { type ArchiveRun, archivePending } from './archive.js'
export {
  type ArchiveProblem,
  type VerifyRun,
  verifyArchive,
  verifyRequested,
} from './archive-verify.js'
export { type AuditCheckResult, checkAuditChains } from './audit.js'
export {
  type ArtifactReader,
  dispatchEmails,
  type MailTransport,
  type OutgoingMail,
  smtpTransport,
} from './email.js'
export { NOTIFICATION_RETENTION_DAYS, purgeReadNotifications } from './notifications.js'
export {
  alertOperations,
  type OperationsAlertOptions,
  type OperationsAlertResult,
} from './operations-alert.js'

/**
 * Background jobs run on pg-boss, i.e. inside PostgreSQL (ADR 0002).
 * Rule: jobs are enqueued in the same transaction as the change that triggers them
 * and every handler must be idempotent.
 */
export const queues = {
  heartbeat: 'system.heartbeat',
  auditCheck: 'audit.check-chain',
  archiveVerify: 'archive.verify',
  notificationPurge: 'notification.purge',
  operationsAlert: 'operations.alert',
  privacyErase: 'privacy.erase-expired',
} as const

export interface Worker {
  stop: () => Promise<void>
}

export async function startWorker(
  config: Pick<
    Config,
    | 'APP_NAME'
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
    | 'ARCHIVE_PREVIOUS_S3_ENDPOINT'
    | 'ARCHIVE_PREVIOUS_S3_REGION'
    | 'ARCHIVE_PREVIOUS_S3_BUCKET'
    | 'ARCHIVE_PREVIOUS_S3_ACCESS_KEY'
    | 'ARCHIVE_PREVIOUS_S3_SECRET_KEY'
    | 'ARCHIVE_PREVIOUS_S3_PATH_STYLE'
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
  // Audit-Kette nachts prüfen (rule 6): all companies, result in the Betriebs-Check.
  const auditSql = createSql({ ...config, DATABASE_POOL_MAX: 1 })
  await boss.createQueue(queues.auditCheck)
  await boss.work(queues.auditCheck, async () => {
    await checkAuditChains(auditSql, logger)
  })
  await boss.schedule(queues.auditCheck, '17 2 * * *', {}, { tz: 'Europe/Berlin' })
  // Benachrichtigungen aufräumen: read ones after 90 days (same small connection).
  await boss.createQueue(queues.notificationPurge)
  await boss.work(queues.notificationPurge, async () => {
    await purgeReadNotifications(auditSql, logger)
  })
  await boss.schedule(queues.notificationPurge, '27 4 * * *', {}, { tz: 'Europe/Berlin' })
  // Betriebswarnung per E-Mail: after the nightly backup, audit and archive checks.
  await boss.createQueue(queues.operationsAlert)
  await boss.work(queues.operationsAlert, async () => {
    await alertOperations(auditSql, logger, {
      smtpEnabled: smtpEnabled(config),
      archiveConfigured: Boolean(config.ARCHIVE_S3_ENDPOINT),
      appName: config.APP_NAME,
    })
  })
  await boss.schedule(queues.operationsAlert, '13 6 * * *', {}, { tz: 'Europe/Berlin' })
  // Löschkonzept (DSGVO): blocked contacts are erased after their retention period.
  await boss.createQueue(queues.privacyErase)
  await boss.work(queues.privacyErase, async () => {
    await eraseExpiredContacts(auditSql, logger)
  })
  await boss.schedule(queues.privacyErase, '7 5 * * *', {}, { tz: 'Europe/Berlin' })
  // E-mail outbox (optional): polled every 15 s, cheap thanks to a partial index.
  let mailTimer: NodeJS.Timeout | undefined
  const sql = smtpEnabled(config) ? createSql({ ...config, DATABASE_POOL_MAX: 1 }) : undefined
  const archive = archiveStoreFromSettings(config)
  if (sql) {
    const transport = smtpTransport(config)
    const mailFiles = new FsObjectStore(config.STORAGE_DIR)
    // Attachments (e.g. Mahnung PDF): working copy, else the WORM archive (ADR 0008).
    const readArtifact = async (key: string): Promise<Buffer | null> => {
      if ((await mailFiles.size(key)) !== null) {
        const chunks: Buffer[] = []
        for await (const chunk of mailFiles.read(key)) chunks.push(chunk as Buffer)
        return Buffer.concat(chunks)
      }
      return archive ? archive.get(key) : null
    }
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        await dispatchEmails(sql, transport, config.SMTP_FROM as string, logger, 10, readArtifact)
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
  const archiveSql = archive ? createSql({ ...config, DATABASE_POOL_MAX: 1 }) : undefined
  if (archive && archiveSql) {
    const files = new FsObjectStore(config.STORAGE_DIR)
    const previous = previousArchiveFromSettings(config)
    if (previous) logger.info({ bucket: previous.bucket }, 'previous archive configured (move)')
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
        // Complete reconciliation after a restore or on request, in steps.
        await verifyRequested(archiveSql, files, archive, previous, logger)
      } catch (err) {
        logger.error({ err }, 'archiving failed')
      } finally {
        running = false
      }
    }
    // Archiv-Abgleich every night: the 500 least recently checked objects, every 10th by content.
    await boss.createQueue(queues.archiveVerify)
    await boss.work(queues.archiveVerify, async () => {
      await verifyArchive(archiveSql, files, archive, previous, logger, {
        limit: 500,
        deepEvery: 10,
      })
    })
    await boss.schedule(queues.archiveVerify, '47 3 * * *', {}, { tz: 'Europe/Berlin' })
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
      await auditSql.end({ timeout: 5 })
      logger.info('worker stopped')
    },
  }
}
