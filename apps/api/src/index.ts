import type { Config } from '@opc/config'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify'

export interface ApiDeps {
  config: Pick<Config, 'APP_NAME' | 'APP_VERSION' | 'APP_ROLE' | 'PROFILE'>
  /** Returns true when all hard dependencies (database) are reachable. */
  isReady: () => Promise<boolean>
  logger?: FastifyServerOptions['logger']
}

/** RFC 9457 problem details with a German, user-facing `detail`. */
export interface Problem {
  type: string
  title: string
  status: number
  detail: string
}

const problem = (status: number, title: string, detail: string): Problem => ({
  type: 'about:blank',
  title,
  status,
  detail,
})

export function buildApi({ config, isReady, logger = false }: ApiDeps): FastifyInstance {
  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    reply
      .status(status)
      .type('application/problem+json')
      .send(
        problem(
          status,
          status >= 500 ? 'Internal Server Error' : error.name,
          status >= 500
            ? 'Es ist ein interner Fehler aufgetreten. Bitte versuchen Sie es später erneut.'
            : error.message,
        ),
      )
  })

  app.setNotFoundHandler((_request, reply) => {
    reply
      .status(404)
      .type('application/problem+json')
      .send(problem(404, 'Not Found', 'Die angeforderte Ressource wurde nicht gefunden.'))
  })

  // Liveness: the process is up. Never touches dependencies.
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }))

  // Readiness: dependencies are reachable; used by Docker healthchecks and the proxy.
  app.get('/readyz', { logLevel: 'silent' }, async (_request, reply) => {
    if (await isReady()) return { status: 'ready' }
    return reply
      .status(503)
      .type('application/problem+json')
      .send(problem(503, 'Service Unavailable', 'Die Datenbank ist derzeit nicht erreichbar.'))
  })

  app.get('/api/v1/meta', async () => ({
    name: config.APP_NAME,
    version: config.APP_VERSION,
    profile: config.PROFILE,
    role: config.APP_ROLE,
  }))

  return app
}
