import { randomInt } from 'node:crypto'
import { buildApi, reencryptLegacyFields } from '@easybau/api'
import { ConfigError, loadConfig, runsApi, runsWorker } from '@easybau/config'
import {
  createSql,
  ensureJobsLogin,
  ensureRuntimeLogin,
  migrate,
  pingDatabase,
  type Sql,
} from '@easybau/db'
import { startWorker, type Worker } from '@easybau/worker'
import { type Logger, pino } from 'pino'

/**
 * Composition root. One image, three roles (ADR 0002):
 *   APP_ROLE=all    → API + worker in one process (profile "compact")
 *   APP_ROLE=api    → HTTP only
 *   APP_ROLE=worker → jobs only; still serves /healthz and /readyz for Docker
 */
async function main(): Promise<void> {
  let config = loadConfig()
  // Reset, invitation and e-mail links and the WebAuthn origin come from PUBLIC_URL; without it
  // they would follow the request's (forwarded) host header (security audit run-1).
  if (config.NODE_ENV === 'production' && runsApi(config.APP_ROLE) && !config.PUBLIC_URL) {
    throw new ConfigError(
      'Invalid configuration:\n  - PUBLIC_URL: Adresse der Installation fehlt (z. B. https://erp.meine-firma.de)',
    )
  }
  const logger = pino({ level: config.LOG_LEVEL, base: { role: config.APP_ROLE } })

  // Migrations run with the admin login, before anything else touches the schema (ADR 0003).
  // Several containers may start at once; the runner serialises itself with an advisory lock.
  if (config.MIGRATE_ON_START && runsApi(config.APP_ROLE)) {
    const admin = createSql({ ...config, DATABASE_POOL_MAX: 1 }, { mode: 'admin' })
    try {
      const result = await migrate(admin, { log: (message) => logger.info(message) })
      logger.info(
        { applied: result.applied.length, total: result.alreadyApplied + result.applied.length },
        'database schema up to date',
      )
      // Encrypted fields written before the field binding get it now (ADR 0013, audit run-1).
      const reencrypted = await reencryptLegacyFields(admin, config.APP_SECRET)
      if (reencrypted) logger.info({ count: reencrypted }, 'encrypted fields bound to their column')
    } finally {
      await admin.end({ timeout: 5 })
    }
  }

  // Application queries use their own login without superuser rights (and switch to the
  // restricted role opc_app), so row level security always applies and cannot be switched off.
  // The job queue gets its own login too, owner of its schema only (ADR 0013).
  const needsJobsLogin = runsWorker(config.APP_ROLE) && !config.DATABASE_JOBS_URL
  if (!config.DATABASE_RUNTIME_URL || needsJobsLogin) {
    const admin = createSql({ ...config, DATABASE_POOL_MAX: 1 }, { mode: 'admin' })
    try {
      if (!config.DATABASE_RUNTIME_URL) {
        const url = await ensureRuntimeLogin(admin, config.DATABASE_URL, config.APP_SECRET)
        config = { ...config, DATABASE_RUNTIME_URL: url }
      }
      if (needsJobsLogin) {
        const url = await ensureJobsLogin(admin, config.DATABASE_URL, config.APP_SECRET)
        config = { ...config, DATABASE_JOBS_URL: url }
      }
    } catch (error) {
      // E.g. an external database whose administrator may not create roles: keep working as
      // before (administrator login, role switch only) and say so.
      logger.warn(
        { err: (error as Error).message },
        'could not create the database logins; set DATABASE_RUNTIME_URL and DATABASE_JOBS_URL',
      )
    } finally {
      await admin.end({ timeout: 5 })
    }
  }
  const sql = createSql(config)

  const setupToken = runsApi(config.APP_ROLE)
    ? await resolveSetupToken(sql, config.SETUP_TOKEN, logger)
    : undefined
  const app = buildApi({
    config,
    isReady: () => pingDatabase(sql),
    ...(runsApi(config.APP_ROLE) && setupToken ? { sql, setupToken, pollMailboxes: true } : {}),
    logger: {
      level: config.LOG_LEVEL,
      // No PII in logs (CLAUDE.md rule 9): log method and path only, never IPs or query strings.
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          path: req.url.split('?')[0],
        }),
      },
    },
  })
  if (!runsApi(config.APP_ROLE)) {
    app.addHook('onRequest', async (request, reply) => {
      if (!['/healthz', '/readyz'].includes(request.url)) reply.code(404).send()
    })
  }

  let worker: Worker | undefined
  if (runsWorker(config.APP_ROLE)) worker = await startWorker(config, logger)
  await app.listen({ host: config.HOST, port: config.PORT })
  logger.info({ profile: config.PROFILE, port: config.PORT }, `${config.APP_NAME} started`)

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down')
    await app.close()
    await worker?.stop()
    await sql.end({ timeout: 5 })
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

/**
 * Ersteinrichtung is protected by a one-time code, so nobody else can claim a freshly deployed
 * public instance. Fixed via SETUP_TOKEN, otherwise random and printed to the log while setup is open.
 */
async function resolveSetupToken(
  sql: Sql,
  configured: string | undefined,
  logger: Logger,
): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const token =
    configured ??
    Array.from({ length: 3 }, () =>
      Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''),
    ).join('-')
  const [row] = await sql<{ done: boolean }[]>`select instance_has_tenant() as done`
  if (!row?.done) {
    logger.warn(
      configured
        ? 'Ersteinrichtung offen: im Browser mit dem Einrichtungscode aus SETUP_TOKEN abschließen.'
        : `Ersteinrichtung offen. Einrichtungscode: ${token}`,
    )
  }
  return token
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message)
  } else {
    console.error(err)
  }
  process.exit(1)
})
