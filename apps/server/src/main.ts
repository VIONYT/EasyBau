import { randomInt } from 'node:crypto'
import { buildApi } from '@opc/api'
import { ConfigError, loadConfig, runsApi, runsWorker } from '@opc/config'
import { createSql, migrate, pingDatabase, type Sql } from '@opc/db'
import { startWorker, type Worker } from '@opc/worker'
import { type Logger, pino } from 'pino'

/**
 * Composition root. One image, three roles (ADR 0002):
 *   APP_ROLE=all    → API + worker in one process (profile "compact")
 *   APP_ROLE=api    → HTTP only
 *   APP_ROLE=worker → jobs only; still serves /healthz and /readyz for Docker
 */
async function main(): Promise<void> {
  const config = loadConfig()
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
    } finally {
      await admin.end({ timeout: 5 })
    }
  }

  // Application queries use the restricted runtime role, so row level security always applies.
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
