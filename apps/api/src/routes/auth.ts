import { withTenant } from '@opc/db'
import {
  changePasswordRequest,
  type LoginResponse,
  loginRequest,
  type Me,
  type SetupStatus,
  setupRequest,
  switchTenantRequest,
  type TotpSetupResponse,
  totpDisableRequest,
  totpEnableRequest,
} from '@opc/schemas'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type AuthContext, requireAuth, type Services, sessionCookieName } from '../context.js'
import { HttpError, parse } from '../http.js'
import { generateTotpSecret, safeEqual, totpUri, verifyTotp } from '../security/crypto.js'
import { hashPassword, verifyDummy, verifyPassword } from '../security/passwords.js'
import {
  createSession,
  deleteSession,
  deleteSessionsOfUser,
  hitRateLimit,
  listMemberships,
  loadSession,
  loadTenantContext,
  resetRateLimit,
} from '../security/sessions.js'

const LOGIN_FAILED = 'E-Mail-Adresse oder Passwort ist falsch.'
const WINDOW = 15 * 60

function setSessionCookie(reply: FastifyReply, services: Services, token: string) {
  reply.setCookie(sessionCookieName(services.config.COOKIE_SECURE), token, {
    httpOnly: true,
    secure: services.config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: services.config.SESSION_TTL_DAYS * 24 * 3600,
  })
}

function clearSessionCookie(reply: FastifyReply, services: Services) {
  reply.clearCookie(sessionCookieName(services.config.COOKIE_SECURE), {
    path: '/',
    secure: services.config.COOKIE_SECURE,
    httpOnly: true,
    sameSite: 'lax',
  })
}

async function rateLimit(services: Services, key: string, limit: number) {
  const result = await hitRateLimit(services.sql, key, limit, WINDOW)
  if (!result.allowed) {
    throw new HttpError(
      429,
      `Zu viele Versuche. Bitte in ${Math.ceil(result.retryAfterSeconds / 60)} Minuten erneut versuchen.`,
    )
  }
}

export async function buildMe(
  services: Services,
  auth: Pick<AuthContext, 'userId' | 'tenantId'>,
): Promise<Me> {
  const [user] = await services.sql<
    { id: string; email: string; displayName: string; totpEnabled: boolean }[]
  >`
    select id, email, display_name as "displayName", (totp_enabled_at is not null) as "totpEnabled"
    from app_user where id = ${auth.userId}`
  const context = await loadTenantContext(services.sql, auth.userId, auth.tenantId)
  if (!user || !context) throw new HttpError(401, 'Bitte melden Sie sich an.')
  return {
    user,
    tenant: { id: context.tenantId, name: context.tenantName },
    role: { key: context.roleKey, name: context.roleName, access: context.access },
    permissions: [...context.permissions].sort(),
    memberships: await listMemberships(services.sql, auth.userId),
    twoFactorSetupRequired: context.roleKey === 'admin' && !user.totpEnabled,
  }
}

async function audit(services: Services, tenantId: string, userId: string, action: string) {
  await withTenant(
    services.sql,
    { tenantId, userId },
    (tx) => tx`
    insert into audit_event (tenant_id, actor_user_id, action, entity, entity_id, hash)
    values (${tenantId}, ${userId}, ${action}, 'app_user', ${userId}, ''::bytea)`,
  )
}

export function registerAuthRoutes(app: FastifyInstance, services: Services) {
  const { sql } = services

  // --- Ersteinrichtung --------------------------------------------------------------------

  app.get('/api/v1/setup/status', async (): Promise<SetupStatus> => {
    const [row] = await sql<{ done: boolean }[]>`select instance_has_tenant() as done`
    return { setupRequired: !row?.done }
  })

  app.post('/api/v1/setup', async (request, reply) => {
    await rateLimit(services, `setup:${request.ip}`, 10)
    const input = parse(setupRequest, request.body)
    if (!safeEqual(input.setupToken, services.setupToken)) {
      throw new HttpError(403, 'Der Einrichtungscode ist falsch. Er steht im Log des Servers.', {
        setupToken: 'Einrichtungscode ist falsch.',
      })
    }
    const passwordHash = await hashPassword(input.admin.password)

    const created = await sql.begin(async (tx) => {
      // Serialise concurrent setup attempts; only the very first one may succeed.
      await tx`select pg_advisory_xact_lock(4711000002)`
      const [state] = await tx<{ done: boolean }[]>`select instance_has_tenant() as done`
      if (state?.done) throw new HttpError(409, 'Die Einrichtung wurde bereits abgeschlossen.')
      const [ids] = await tx<{ tenantId: string; userId: string }[]>`
        select uuid_v7() as "tenantId", uuid_v7() as "userId"`
      const { tenantId, userId } = ids as { tenantId: string; userId: string }
      const existing = await tx`select 1 from app_user where lower(email) = ${input.admin.email}`
      if (existing.length) throw new HttpError(409, 'Diese E-Mail-Adresse ist bereits registriert.')
      await tx`insert into app_user (id, email, display_name, password_hash)
               values (${userId}, ${input.admin.email}, ${input.admin.displayName}, ${passwordHash})`
      await tx`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true)`
      const c = input.company
      await tx`insert into tenant (id, name, legal_form, trade, street, postal_code, city, country_code,
                                   federal_state, email, phone)
               values (${tenantId}, ${c.name}, ${c.legalForm ?? null}, ${c.trade ?? null}, ${c.street ?? null},
                       ${c.postalCode ?? null}, ${c.city ?? null}, ${c.countryCode}, ${c.federalState ?? null},
                       ${c.email ?? null}, ${c.phone ?? null})`
      await tx`select seed_tenant_defaults()`
      await tx`insert into membership (tenant_id, user_id, role_id)
               select ${tenantId}, ${userId}, id from role where key = 'admin'`
      await tx`insert into audit_event (tenant_id, actor_user_id, action, entity, entity_id, hash)
               values (${tenantId}, ${userId}, 'setup', 'tenant', ${tenantId}, ''::bytea)`
      return { tenantId, userId }
    })

    const token = await createSession(sql, {
      ...created,
      userAgent: request.headers['user-agent'],
      ttlDays: services.config.SESSION_TTL_DAYS,
      mfaVerified: false,
    })
    setSessionCookie(reply, services, token)
    return reply.status(201).send(await buildMe(services, created))
  })

  // --- Anmeldung ------------------------------------------------------------------------------

  app.post('/api/v1/auth/login', async (request, reply): Promise<LoginResponse> => {
    const input = parse(loginRequest, request.body)
    await rateLimit(services, `login:ip:${request.ip}`, 50)
    await rateLimit(services, `login:email:${input.email}`, 10)

    const [user] = await sql<
      {
        id: string
        passwordHash: string | null
        totpSecret: Buffer | null
        totpLastStep: string | null
      }[]
    >`
      select id, password_hash as "passwordHash", totp_secret_enc as "totpSecret", totp_last_step as "totpLastStep"
      from app_user where lower(email) = ${input.email} and is_active`
    if (!user?.passwordHash) {
      await verifyDummy(input.password)
      throw new HttpError(401, LOGIN_FAILED)
    }
    if (!(await verifyPassword(user.passwordHash, input.password)))
      throw new HttpError(401, LOGIN_FAILED)

    let mfaVerified = false
    if (user.totpSecret) {
      if (!input.totp) return { status: 'totp_required' }
      const step = verifyTotp(
        services.cipher.decrypt(user.totpSecret),
        input.totp,
        services.now(),
        user.totpLastStep === null ? null : Number(user.totpLastStep),
      )
      if (step === null)
        throw new HttpError(401, 'Der Bestätigungscode ist ungültig oder abgelaufen.', {
          totp: 'Code ungültig.',
        })
      await sql`update app_user set totp_last_step = ${step} where id = ${user.id}`
      mfaVerified = true
    }

    const memberships = await listMemberships(sql, user.id)
    const membership = memberships.find((m) => m.tenantId === input.tenantId) ?? memberships[0]
    if (!membership) throw new HttpError(403, 'Ihr Zugang ist keiner Firma zugeordnet.')

    await resetRateLimit(sql, `login:email:${input.email}`)
    await sql`update app_user set last_login_at = now(), failed_logins = 0 where id = ${user.id}`
    const token = await createSession(sql, {
      userId: user.id,
      tenantId: membership.tenantId,
      userAgent: request.headers['user-agent'],
      ttlDays: services.config.SESSION_TTL_DAYS,
      mfaVerified,
    })
    await audit(services, membership.tenantId, user.id, 'login')
    setSessionCookie(reply, services, token)
    return {
      status: 'ok',
      me: await buildMe(services, { userId: user.id, tenantId: membership.tenantId }),
    }
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookieName(services.config.COOKIE_SECURE)]
    if (token) await deleteSession(sql, token)
    clearSessionCookie(reply, services)
    return reply.status(204).send()
  })

  app.get(
    '/api/v1/auth/me',
    async (request): Promise<Me> => buildMe(services, requireAuth(request)),
  )

  app.post('/api/v1/auth/switch-tenant', async (request): Promise<Me> => {
    const auth = requireAuth(request)
    const { tenantId } = parse(switchTenantRequest, request.body)
    if (!(await loadTenantContext(sql, auth.userId, tenantId))) {
      throw new HttpError(403, 'Sie sind dieser Firma nicht zugeordnet.')
    }
    await sql`update user_session set active_tenant_id = ${tenantId} where id = ${auth.sessionId}`
    return buildMe(services, { userId: auth.userId, tenantId })
  })

  app.post('/api/v1/auth/password', async (request, reply) => {
    const auth = requireAuth(request)
    const input = parse(changePasswordRequest, request.body)
    await rateLimit(services, `password:${auth.userId}`, 10)
    const [user] = await sql<{ passwordHash: string | null }[]>`
      select password_hash as "passwordHash" from app_user where id = ${auth.userId}`
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw new HttpError(403, 'Das aktuelle Passwort ist falsch.', {
        currentPassword: 'Passwort ist falsch.',
      })
    }
    await sql`update app_user set password_hash = ${await hashPassword(input.newPassword)} where id = ${auth.userId}`
    await deleteSessionsOfUser(sql, auth.userId, auth.sessionId)
    await audit(services, auth.tenantId, auth.userId, 'password_changed')
    return reply.status(204).send()
  })

  // --- Zwei-Faktor (TOTP) ----------------------------------------------------------------------

  app.post('/api/v1/auth/totp/setup', async (request): Promise<TotpSetupResponse> => {
    const auth = requireAuth(request)
    if (auth.totpEnabled) throw new HttpError(409, 'Die Zwei-Faktor-Anmeldung ist bereits aktiv.')
    const secret = generateTotpSecret()
    await sql`update app_user set totp_pending_secret_enc = ${services.cipher.encrypt(secret)} where id = ${auth.userId}`
    return { secret, uri: totpUri(secret, auth.email, services.config.APP_NAME) }
  })

  app.post('/api/v1/auth/totp/enable', async (request, reply) => {
    const auth = requireAuth(request)
    const { code } = parse(totpEnableRequest, request.body)
    const [user] = await sql<{ pending: Buffer | null }[]>`
      select totp_pending_secret_enc as pending from app_user where id = ${auth.userId}`
    if (!user?.pending) throw new HttpError(409, 'Bitte zuerst die Einrichtung starten.')
    const secret = services.cipher.decrypt(user.pending)
    const step = verifyTotp(secret, code, services.now())
    if (step === null)
      throw new HttpError(400, 'Der Code passt nicht. Bitte Uhrzeit des Telefons prüfen.', {
        code: 'Code ungültig.',
      })
    await sql`update app_user set totp_secret_enc = totp_pending_secret_enc, totp_pending_secret_enc = null,
              totp_enabled_at = now(), totp_last_step = ${step} where id = ${auth.userId}`
    await sql`update user_session set mfa_verified = true where id = ${auth.sessionId}`
    await deleteSessionsOfUser(sql, auth.userId, auth.sessionId)
    await audit(services, auth.tenantId, auth.userId, 'totp_enabled')
    return reply.status(204).send()
  })

  app.post('/api/v1/auth/totp/disable', async (request, reply) => {
    const auth = requireAuth(request)
    const input = parse(totpDisableRequest, request.body)
    const [user] = await sql<
      { passwordHash: string | null; secret: Buffer | null; lastStep: string | null }[]
    >`
      select password_hash as "passwordHash", totp_secret_enc as secret, totp_last_step as "lastStep"
      from app_user where id = ${auth.userId}`
    if (!user?.secret) throw new HttpError(409, 'Die Zwei-Faktor-Anmeldung ist nicht aktiv.')
    const passwordOk =
      !!user.passwordHash && (await verifyPassword(user.passwordHash, input.password))
    const step = verifyTotp(
      services.cipher.decrypt(user.secret),
      input.code,
      services.now(),
      user.lastStep === null ? null : Number(user.lastStep),
    )
    if (!passwordOk || step === null) throw new HttpError(403, 'Passwort oder Code ist falsch.')
    await sql`update app_user set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null
              where id = ${auth.userId}`
    await audit(services, auth.tenantId, auth.userId, 'totp_disabled')
    return reply.status(204).send()
  })
}

/** Loads the session from the cookie and attaches request.auth (null if not logged in). */
export function authHook(services: Services) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    request.auth = null
    const token = request.cookies[sessionCookieName(services.config.COOKIE_SECURE)]
    if (!token) return
    const session = await loadSession(services.sql, token, services.config.SESSION_IDLE_HOURS)
    if (!session?.tenantId) {
      clearSessionCookie(reply, services)
      return
    }
    const context = await loadTenantContext(services.sql, session.userId, session.tenantId)
    if (!context) {
      clearSessionCookie(reply, services)
      return
    }
    request.auth = {
      sessionId: session.id,
      userId: session.userId,
      email: session.email,
      displayName: session.displayName,
      totpEnabled: session.totpEnabled,
      tenantId: context.tenantId,
      tenantName: context.tenantName,
      roleKey: context.roleKey,
      roleName: context.roleName,
      access: context.access,
      permissions: new Set(context.permissions),
    }
  }
}
