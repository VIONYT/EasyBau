import { withTenant } from '@easybau/db'
import type { LoginResponse, Me, MfaMethod } from '@easybau/schemas'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  type AuthContext,
  challengeCookieName,
  mfaSetupRequired,
  type Services,
  sessionCookieName,
} from '../context.js'
import { HttpError } from '../http.js'
import { randomToken, sha256 } from '../security/crypto.js'
import {
  createSession,
  hitRateLimit,
  listMemberships,
  loadTenantContext,
} from '../security/sessions.js'
import { rememberDevice } from './security-notices.js'

const WINDOW = 15 * 60
/** A pending login (password ok, second factor outstanding) is valid for 5 minutes. */
const CHALLENGE_TTL_SECONDS = 5 * 60
export const MAX_CHALLENGE_ATTEMPTS = 5

export async function rateLimit(services: Services, key: string, limit: number) {
  const result = await hitRateLimit(services.sql, key, limit, WINDOW)
  if (!result.allowed) {
    throw new HttpError(
      429,
      `Zu viele Versuche. Bitte in ${Math.ceil(result.retryAfterSeconds / 60)} Minuten erneut versuchen.`,
    )
  }
}

const cookieBase = (services: Services) => ({
  httpOnly: true,
  secure: services.config.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
})

export function setSessionCookie(reply: FastifyReply, services: Services, token: string) {
  reply.setCookie(sessionCookieName(services.config.COOKIE_SECURE), token, {
    ...cookieBase(services),
    maxAge: services.config.SESSION_TTL_DAYS * 24 * 3600,
  })
}

export function clearSessionCookie(reply: FastifyReply, services: Services) {
  reply.clearCookie(sessionCookieName(services.config.COOKIE_SECURE), cookieBase(services))
}

export function clearChallengeCookie(reply: FastifyReply, services: Services) {
  reply.clearCookie(challengeCookieName(services.config.COOKIE_SECURE), cookieBase(services))
}

export async function audit(
  services: Services,
  tenantId: string,
  userId: string,
  action: string,
  entityId: string = userId,
) {
  await withTenant(
    services.sql,
    { tenantId, userId },
    (tx) => tx`
    insert into audit_event (tenant_id, actor_user_id, action, entity, entity_id, hash)
    values (${tenantId}, ${userId}, ${action}, 'app_user', ${entityId}, ''::bytea)`,
  )
}

export async function buildMe(
  services: Services,
  auth: Pick<AuthContext, 'userId' | 'tenantId'>,
): Promise<Me> {
  const [user] = await services.sql<Me['user'][]>`
    select id, email, display_name as "displayName", (totp_enabled_at is not null) as "totpEnabled",
           (select count(*)::int from webauthn_credential w where w.user_id = u.id) as "webauthnCount",
           (email_verified_at is not null) as "emailVerified"
    from app_user u where id = ${auth.userId}`
  const context = await loadTenantContext(services.sql, auth.userId, auth.tenantId)
  if (!user || !context) throw new HttpError(401, 'Bitte melden Sie sich an.')
  return {
    user,
    tenant: { id: context.tenantId, name: context.tenantName },
    role: { key: context.roleKey, name: context.roleName, access: context.access },
    permissions: [...context.permissions].sort(),
    memberships: await listMemberships(services.sql, auth.userId),
    twoFactorSetupRequired: mfaSetupRequired(services, { roleKey: context.roleKey, ...user }),
  }
}

/** Second factors the user has set up. */
export async function mfaMethodsOf(services: Services, userId: string): Promise<MfaMethod[]> {
  const [row] = await services.sql<{ totp: boolean; webauthn: boolean }[]>`
    select (totp_enabled_at is not null) as totp,
           exists (select 1 from webauthn_credential w where w.user_id = u.id) as webauthn
    from app_user u where id = ${userId}`
  const methods: MfaMethod[] = []
  if (row?.totp) methods.push('totp')
  if (row?.webauthn) methods.push('webauthn')
  return methods
}

/** Creates the session for a fully authenticated user and returns the login response. */
export async function finishLogin(
  services: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    userId: string
    requestedTenantId?: string | null | undefined
    mfaVerified: boolean
    method: string
  },
): Promise<LoginResponse> {
  const memberships = await listMemberships(services.sql, input.userId)
  const membership =
    memberships.find((m) => m.tenantId === input.requestedTenantId) ?? memberships[0]
  if (!membership) throw new HttpError(403, 'Ihr Zugang ist keiner Firma zugeordnet.')
  await services.sql`update app_user set last_login_at = now(), failed_logins = 0 where id = ${input.userId}`
  const token = await createSession(services.sql, {
    userId: input.userId,
    tenantId: membership.tenantId,
    userAgent: request.headers['user-agent'],
    ttlDays: services.config.SESSION_TTL_DAYS,
    mfaVerified: input.mfaVerified,
  })
  await audit(services, membership.tenantId, input.userId, `login:${input.method}`)
  if (await rememberDevice(services, request, reply, input.userId)) {
    await audit(services, membership.tenantId, input.userId, 'login_new_device')
  }
  clearChallengeCookie(reply, services)
  setSessionCookie(reply, services, token)
  return {
    status: 'ok',
    me: await buildMe(services, { userId: input.userId, tenantId: membership.tenantId }),
  }
}

export type ChallengePurpose = 'mfa_login' | 'passkey_login' | 'webauthn_register'

export interface ChallengeRow {
  id: string
  userId: string | null
  requestedTenantId: string | null
  challenge: string | null
  attempts: number
}

/** Stores a short-lived challenge; the random handle goes into an HttpOnly cookie. */
export async function createChallenge(
  services: Services,
  reply: FastifyReply,
  input: {
    purpose: ChallengePurpose
    userId?: string | null
    requestedTenantId?: string | null
    challenge?: string
  },
): Promise<void> {
  await services.sql`delete from auth_challenge where expires_at < now()`
  const handle = randomToken()
  await services.sql`
    insert into auth_challenge (token_hash, purpose, user_id, requested_tenant_id, challenge, expires_at)
    values (${sha256(handle)}, ${input.purpose}, ${input.userId ?? null}, ${input.requestedTenantId ?? null},
            ${input.challenge ?? null}, now() + make_interval(secs => ${CHALLENGE_TTL_SECONDS}))`
  reply.setCookie(challengeCookieName(services.config.COOKIE_SECURE), handle, {
    ...cookieBase(services),
    maxAge: CHALLENGE_TTL_SECONDS,
  })
}

/** Loads the challenge of the current cookie, counting the attempt. Throws if missing/expired/exhausted. */
export async function useChallenge(
  services: Services,
  request: FastifyRequest,
  purpose: ChallengePurpose,
): Promise<ChallengeRow> {
  const handle = request.cookies[challengeCookieName(services.config.COOKIE_SECURE)]
  const expired = new HttpError(401, 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.')
  if (!handle) throw expired
  const [row] = await services.sql<ChallengeRow[]>`
    update auth_challenge set attempts = attempts + 1
    where token_hash = ${sha256(handle)} and purpose = ${purpose} and expires_at > now()
    returning id, user_id as "userId", requested_tenant_id as "requestedTenantId", challenge, attempts`
  if (!row) throw expired
  if (row.attempts > MAX_CHALLENGE_ATTEMPTS) {
    await services.sql`delete from auth_challenge where id = ${row.id}`
    throw new HttpError(429, 'Zu viele Versuche. Bitte erneut anmelden.')
  }
  return row
}

export async function setChallengeValue(services: Services, id: string, challenge: string) {
  await services.sql`update auth_challenge set challenge = ${challenge} where id = ${id}`
}

export async function deleteChallenge(services: Services, id: string) {
  await services.sql`delete from auth_challenge where id = ${id}`
}
