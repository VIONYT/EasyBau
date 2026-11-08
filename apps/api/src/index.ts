import cookie from '@fastify/cookie'
import type { Config } from '@opc/config'
import type { Sql } from '@opc/db'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify'
import type { Services } from './context.js'
import { HttpError, problem, sendProblem } from './http.js'
import { idempotencyHooks } from './idempotency.js'
import { authHook, mfaEnforcementHook, registerAuthRoutes } from './routes/auth.js'
import { registerContactRoutes } from './routes/contacts.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerUserRoutes } from './routes/users.js'
import { registerWebauthnRoutes } from './routes/webauthn.js'
import { FieldCipher } from './security/crypto.js'

export { HttpError } from './http.js'
export { hashPassword } from './security/passwords.js'

export interface ApiDeps {
  config: Pick<Config, 'APP_NAME' | 'APP_VERSION' | 'APP_ROLE' | 'PROFILE'> &
    Partial<
      Pick<
        Config,
        | 'APP_SECRET'
        | 'SESSION_TTL_DAYS'
        | 'SESSION_IDLE_HOURS'
        | 'COOKIE_SECURE'
        | 'PUBLIC_URL'
        | 'REQUIRE_ADMIN_MFA'
      >
    >
  /** Returns true when all hard dependencies (database) are reachable. */
  isReady: () => Promise<boolean>
  logger?: FastifyServerOptions['logger']
  /** Runtime database pool (role opc_app). Without it only health and meta routes exist. */
  sql?: Sql
  /** One-time setup code (Ersteinrichtung). Required together with `sql`. */
  setupToken?: string
  /** Clock for TOTP; injectable for tests. */
  now?: () => number
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function buildApi({
  config,
  isReady,
  logger = false,
  sql,
  setupToken,
  now = Date.now,
}: ApiDeps): FastifyInstance {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 1024 * 1024 })

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError)
      return sendProblem(reply, error.statusCode, error.message, error.errors)
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed')
      return sendProblem(
        reply,
        500,
        'Es ist ein interner Fehler aufgetreten. Bitte versuchen Sie es später erneut.',
      )
    }
    if (status === 415)
      return sendProblem(
        reply,
        415,
        'Bitte Daten als JSON senden (Content-Type: application/json).',
      )
    if (status === 400)
      return sendProblem(reply, 400, 'Die Anfrage konnte nicht gelesen werden (ungültiges JSON).')
    return sendProblem(reply, status, error.message)
  })

  app.setNotFoundHandler((_request, reply) =>
    reply
      .status(404)
      .type('application/problem+json')
      .send(problem(404, 'Die angeforderte Ressource wurde nicht gefunden.')),
  )

  // Liveness: the process is up. Never touches dependencies.
  app.get('/healthz', { logLevel: 'silent' }, async () => ({ status: 'ok' }))

  // Readiness: dependencies are reachable; used by Docker healthchecks and the proxy.
  app.get('/readyz', { logLevel: 'silent' }, async (_request, reply) => {
    if (await isReady()) return { status: 'ready' }
    return sendProblem(reply, 503, 'Die Datenbank ist derzeit nicht erreichbar.')
  })

  app.get('/api/v1/meta', async () => ({
    name: config.APP_NAME,
    version: config.APP_VERSION,
    profile: config.PROFILE,
    role: config.APP_ROLE,
  }))

  if (!sql) return app
  if (!config.APP_SECRET || !setupToken)
    throw new Error('APP_SECRET and setupToken are required with a database')

  const services: Services = {
    sql,
    cipher: new FieldCipher(config.APP_SECRET),
    config: {
      APP_NAME: config.APP_NAME,
      SESSION_TTL_DAYS: config.SESSION_TTL_DAYS ?? 30,
      SESSION_IDLE_HOURS: config.SESSION_IDLE_HOURS ?? 24 * 7,
      COOKIE_SECURE: config.COOKIE_SECURE ?? true,
      PUBLIC_URL: config.PUBLIC_URL,
      REQUIRE_ADMIN_MFA: config.REQUIRE_ADMIN_MFA ?? true,
    },
    setupToken,
    now,
  }

  app.register(cookie)

  // CSRF protection: session cookies are SameSite=Lax; additionally reject cross-site
  // state-changing requests (Fetch Metadata and Origin check). Bodies must be JSON.
  app.addHook('onRequest', async (request, reply) => {
    if (!MUTATING.has(request.method)) return
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return sendProblem(reply, 403, 'Anfragen von fremden Websites sind nicht erlaubt.')
    }
    const origin = request.headers.origin
    if (origin && origin !== 'null') {
      let host: string | undefined
      try {
        host = new URL(origin).host
      } catch {
        host = undefined
      }
      if (host !== request.headers.host) {
        return sendProblem(reply, 403, 'Anfragen von fremden Websites sind nicht erlaubt.')
      }
    }
  })

  app.addHook('preHandler', authHook(services))
  app.addHook('preHandler', mfaEnforcementHook(services))
  const idempotency = idempotencyHooks(services)
  app.addHook('preHandler', idempotency.preHandler)
  app.addHook('onSend', idempotency.onSend)

  registerAuthRoutes(app, services)
  registerContactRoutes(app, services)
  registerProjectRoutes(app, services)
  registerUserRoutes(app, services)
  registerWebauthnRoutes(app, services)
  return app
}
