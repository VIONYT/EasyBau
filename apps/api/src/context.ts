import type { Config } from '@opc/config'
import type { Sql, Tx } from '@opc/db'
import { withTenant } from '@opc/db'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { forbidden, HttpError } from './http.js'
import type { FieldCipher } from './security/crypto.js'

export interface AuthContext {
  sessionId: string
  userId: string
  email: string
  displayName: string
  totpEnabled: boolean
  tenantId: string
  tenantName: string
  roleKey: string
  roleName: string
  access: 'office' | 'site' | 'readonly'
  permissions: ReadonlySet<string>
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
    idempotency: { key: string; tenantId: string } | null
  }
}

/** Everything the routes need; built once in buildApi. */
export interface Services {
  sql: Sql
  cipher: FieldCipher
  config: Pick<Config, 'APP_NAME' | 'SESSION_TTL_DAYS' | 'SESSION_IDLE_HOURS' | 'COOKIE_SECURE'>
  /** One-time code required for the initial setup. */
  setupToken: string
  now: () => number
}

export const SESSION_COOKIE_SECURE = '__Host-sid'
export const SESSION_COOKIE_PLAIN = 'sid'

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new HttpError(401, 'Bitte melden Sie sich an.')
  return request.auth
}

/** Server-side permission check (rule 9: never only hidden in the UI). */
export function requirePermission(request: FastifyRequest, ...permissions: string[]): AuthContext {
  const auth = requireAuth(request)
  if (!permissions.every((p) => auth.permissions.has(p))) throw forbidden()
  return auth
}

/** Runs a query block in the tenant of the current session (RLS + audit actor). */
export function inTenant<T>(
  services: Services,
  auth: AuthContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTenant(services.sql, { tenantId: auth.tenantId, userId: auth.userId }, fn)
}

export type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
