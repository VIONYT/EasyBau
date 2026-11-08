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
  webauthnCount: number
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
  config: Pick<
    Config,
    'APP_NAME' | 'SESSION_TTL_DAYS' | 'SESSION_IDLE_HOURS' | 'COOKIE_SECURE' | 'REQUIRE_ADMIN_MFA'
  > & {
    PUBLIC_URL?: string | undefined
  }
  /** One-time code required for the initial setup. */
  setupToken: string
  now: () => number
}

export const SESSION_COOKIE_SECURE = '__Host-sid'
export const SESSION_COOKIE_PLAIN = 'sid'

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN
}

/** Short-lived cookie for a login that still needs its second factor or a passkey challenge. */
export function challengeCookieName(secure: boolean): string {
  return secure ? '__Host-challenge' : 'challenge'
}

/** Does this admin still have to set up a second factor (DESIGN.md §5.2)? */
export function mfaSetupRequired(
  services: Services,
  auth: Pick<AuthContext, 'roleKey' | 'totpEnabled' | 'webauthnCount'>,
): boolean {
  return (
    services.config.REQUIRE_ADMIN_MFA &&
    auth.roleKey === 'admin' &&
    !auth.totpEnabled &&
    auth.webauthnCount === 0
  )
}

/** Public origin of the instance: PUBLIC_URL, otherwise derived from the request (behind the proxy). */
export function publicOrigin(services: Services, request: FastifyRequest): string {
  return services.config.PUBLIC_URL ?? `${request.protocol}://${request.host}`
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
