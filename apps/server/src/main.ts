import { buildApi } from '@opc/api'
import { ConfigError, loadConfig, runsApi, runsWorker } from '@opc/config'
import { createSql, pingDatabase } from '@opc/db'
import { startWorker, type Worker } from '@opc/worker'
import { pino } from 'pino'

/**
 * Composition root. One image, three roles (ADR 0002):
 *   APP_ROLE=all    → API + worker in one process (profile "compact")
 *   APP_ROLE=api    → HTTP only
 *   APP_ROLE=worker → jobs only; still serves /healthz and /readyz for Docker
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const logger = pino({ level: config.LOG_LEVEL, base: { role: config.APP_ROLE } })
  const sql = createSql(config)

  const app = buildApi({
    config,
    isReady: () => pingDatabase(sql),
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

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message)
  } else {
    console.error(err)
  }
  process.exit(1)
})
