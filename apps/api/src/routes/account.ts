import { type Sql, withTenant } from '@opc/db'
import {
  type AdminPasswordReset,
  accountTokenRequest,
  adminPasswordResetRequest,
  type EmailVerificationRequested,
  type PasswordResetInfo,
  type PasswordResetRequested,
  passwordResetConfirm,
  passwordResetRequest,
} from '@opc/schemas'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  type AuthContext,
  inTenant,
  publicOrigin,
  requireAuth,
  requirePermission,
  type Services,
} from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { randomToken, sha256 } from '../security/crypto.js'
import { hashPassword } from '../security/passwords.js'
import { deleteSessionsOfUser } from '../security/sessions.js'
import { audit, rateLimit } from './auth-common.js'
import { queueEmail } from './email.js'

/**
 * Konto (P2.10): Passwort vergessen (link by e-mail), Zurücksetzen durch die Administration
 * (link to hand over, also without SMTP) and E-Mail-Bestätigung.
 *
 * Security: the link carries a 256-bit random token, the database only its SHA-256; links are
 * single-use and short-lived (30 min self-service, 24 h from the administration, 48 h for the
 * confirmation). The request never reveals whether an address has a login. A new password is
 * stored as argon2id, ends all sessions and keeps the second factor – the next login still asks
 * for it.
 */

const SELF_RESET_MINUTES = 30
const ADMIN_RESET_HOURS = 24
const VERIFY_HOURS = 48
const GENERIC_INVALID = 'Der Link ist ungültig oder abgelaufen. Bitte einen neuen anfordern.'

type Purpose = 'password_reset' | 'email_verify'

interface TokenRow {
  id: string
  userId: string
  email: string
  displayName: string
  userEmail: string
  expiresAt: string
  createdBy: string | null
}

async function createToken(
  sql: Sql,
  input: {
    userId: string
    purpose: Purpose
    email: string
    minutes: number
    createdBy?: string | null
  },
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32)
  // Expired links are kept a week for questions, then removed.
  await sql`delete from account_token where expires_at < now() - interval '7 days'`
  // Only the newest link of a kind is valid.
  await sql`delete from account_token where user_id = ${input.userId} and purpose = ${input.purpose}
            and used_at is null`
  const [row] = await sql<{ expiresAt: string }[]>`
    insert into account_token (user_id, purpose, token_hash, email, created_by, expires_at)
    values (${input.userId}, ${input.purpose}, ${sha256(token)}, ${input.email}, ${input.createdBy ?? null},
            now() + make_interval(mins => ${input.minutes}))
    returning to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "expiresAt"`
  return { token, expiresAt: (row as { expiresAt: string }).expiresAt }
}

async function findToken(sql: Sql, token: string, purpose: Purpose): Promise<TokenRow | null> {
  const [row] = await sql<TokenRow[]>`
    select t.id, t.user_id as "userId", t.email, u.display_name as "displayName", u.email as "userEmail",
           to_char(t.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "expiresAt",
           t.created_by as "createdBy"
    from account_token t join app_user u on u.id = t.user_id
    where t.token_hash = ${sha256(token)} and t.purpose = ${purpose}
      and t.used_at is null and t.expires_at > now() and u.is_active`
  return row ?? null
}

/** Mails go out in the name of the person's first company (outbox, footer, reply-to). */
async function firstTenantOf(
  sql: Sql,
  userId: string,
): Promise<{ tenantId: string; tenantName: string } | null> {
  const [row] = await sql<{ tenantId: string; tenantName: string }[]>`
    select tenant_id as "tenantId", tenant_name as "tenantName" from user_memberships(${userId}) limit 1`
  return row ?? null
}

async function auditEverywhere(
  services: Services,
  userId: string,
  actorId: string,
  action: string,
) {
  const tenants = await services.sql<{ tenantId: string }[]>`
    select tenant_id as "tenantId" from user_memberships(${userId})`
  for (const { tenantId } of tenants) await audit(services, tenantId, actorId, action, userId)
}

async function mail(
  services: Services,
  userId: string,
  kind: Purpose,
  to: string,
  subject: string,
  text: string,
) {
  const tenant = await firstTenantOf(services.sql, userId)
  if (!tenant) return false
  await withTenant(services.sql, { tenantId: tenant.tenantId, userId }, (tx) =>
    queueEmail(tx, { tenantId: tenant.tenantId, userId } as AuthContext, {
      kind,
      to,
      subject,
      text,
    }),
  )
  return true
}

const resetUrl = (services: Services, request: FastifyRequest, token: string) =>
  `${publicOrigin(services, request)}/passwort-zuruecksetzen#${token}`

export function registerAccountRoutes(app: FastifyInstance, services: Services) {
  const sql = services.sql
  const appName = services.config.APP_NAME

  // Passwort vergessen: always the same answer, so nobody learns whether an address has a login.
  app.post('/api/v1/auth/password-reset/request', async (request, reply) => {
    const { email } = parse(passwordResetRequest, request.body)
    await rateLimit(services, `reset:ip:${request.ip}`, 10)
    await rateLimit(services, `reset:email:${email}`, 3)
    const body: PasswordResetRequested = { emailEnabled: services.config.SMTP_ENABLED }
    if (!services.config.SMTP_ENABLED) return reply.status(202).send(body)
    const [user] = await sql<{ id: string; email: string; displayName: string }[]>`
      select id, email, display_name as "displayName" from app_user where lower(email) = ${email} and is_active`
    if (user) {
      const { token } = await createToken(sql, {
        userId: user.id,
        purpose: 'password_reset',
        email: user.email,
        minutes: SELF_RESET_MINUTES,
      })
      await mail(
        services,
        user.id,
        'password_reset',
        user.email,
        `${appName}: Passwort zurücksetzen`,
        [
          `Hallo ${user.displayName},`,
          '',
          `für Ihre Anmeldung bei ${appName} wurde ein neues Passwort angefordert. Über diesen Link legen Sie es fest:`,
          '',
          resetUrl(services, request, token),
          '',
          `Der Link ist ${SELF_RESET_MINUTES} Minuten gültig und nur einmal verwendbar. Ihr zweiter Faktor (Sicherheitsschlüssel oder App) bleibt bestehen.`,
          '',
          'Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail – Ihr Passwort bleibt unverändert.',
        ].join('\n'),
      )
    }
    return reply.status(202).send(body)
  })

  app.post('/api/v1/auth/password-reset/lookup', async (request): Promise<PasswordResetInfo> => {
    const { token } = parse(accountTokenRequest, request.body)
    await rateLimit(services, `reset-token:ip:${request.ip}`, 30)
    const row = await findToken(sql, token, 'password_reset')
    if (!row) throw new HttpError(410, GENERIC_INVALID)
    return { email: row.userEmail, displayName: row.displayName, expiresAt: row.expiresAt }
  })

  app.post('/api/v1/auth/password-reset/confirm', async (request, reply) => {
    const { token, password } = parse(passwordResetConfirm, request.body)
    await rateLimit(services, `reset-token:ip:${request.ip}`, 30)
    const row = await findToken(sql, token, 'password_reset')
    if (!row) throw new HttpError(410, GENERIC_INVALID)
    const passwordHash = await hashPassword(password)
    const used =
      await sql`update account_token set used_at = now() where id = ${row.id} and used_at is null`
    if (!used.count) throw new HttpError(410, GENERIC_INVALID)
    // The link went to the login's address: whoever opened it controls that inbox.
    const confirmsEmail = !row.createdBy && row.email.toLowerCase() === row.userEmail.toLowerCase()
    await sql`
      update app_user set password_hash = ${passwordHash}, failed_logins = 0, locked_until = null,
             email_verified_at = case when ${confirmsEmail} then coalesce(email_verified_at, now())
                                      else email_verified_at end
      where id = ${row.userId}`
    await sql`delete from account_token where user_id = ${row.userId} and purpose = 'password_reset' and used_at is null`
    await deleteSessionsOfUser(sql, row.userId)
    await auditEverywhere(services, row.userId, row.createdBy ?? row.userId, 'password_reset')
    return reply.status(204).send()
  })

  // Administration: link for one person of this company (handed over in person or by e-mail).
  app.post(
    '/api/v1/users/:userId/password-reset',
    async (request, reply): Promise<AdminPasswordReset> => {
      const auth = requirePermission(request, 'users.manage')
      const { userId } = parse(z.object({ userId: z.uuid('Ungültige ID.') }), request.params)
      const { sendEmail } = parse(adminPasswordResetRequest, request.body ?? {})
      if (userId === auth.userId) {
        throw new HttpError(409, 'Ihr eigenes Passwort ändern Sie unter „Sicherheit“.')
      }
      const [member] = await inTenant(
        services,
        auth,
        (tx) => tx`select 1 from membership where user_id = ${userId}`,
      )
      if (!member) throw notFound('Die Person')
      // A company must not take over a login that also opens other companies.
      const [other] = await sql<
        { n: number }[]
      >`select count(*)::int as n from user_memberships(${userId})`
      if ((other?.n ?? 0) > 1) {
        throw new HttpError(
          409,
          'Diese Person gehört zu mehreren Firmen. Sie kann „Passwort vergessen“ bei der Anmeldung nutzen.',
        )
      }
      const [user] = await sql<{ email: string; displayName: string }[]>`
      select email, display_name as "displayName" from app_user where id = ${userId} and is_active`
      if (!user) throw notFound('Die Person')
      const { token, expiresAt } = await createToken(sql, {
        userId,
        purpose: 'password_reset',
        email: user.email,
        minutes: ADMIN_RESET_HOURS * 60,
        createdBy: auth.userId,
      })
      const url = resetUrl(services, request, token)
      const emailQueued = Boolean(sendEmail && services.config.SMTP_ENABLED)
      if (emailQueued) {
        await inTenant(services, auth, (tx) =>
          queueEmail(tx, auth, {
            kind: 'password_reset',
            to: user.email,
            subject: `${appName}: Neues Passwort festlegen`,
            text: [
              `Hallo ${user.displayName},`,
              '',
              `${auth.displayName} hat für Sie einen Link zum Festlegen eines neuen Passworts bei ${auth.tenantName} erstellt:`,
              '',
              url,
              '',
              `Der Link ist ${ADMIN_RESET_HOURS} Stunden gültig und nur einmal verwendbar.`,
            ].join('\n'),
          }),
        )
      }
      await audit(services, auth.tenantId, auth.userId, 'password_reset_link', userId)
      return reply.status(201).send({ resetUrl: url, expiresAt, emailQueued })
    },
  )

  // E-Mail-Bestätigung: link to the address of the login.
  app.post('/api/v1/auth/email/verify-request', async (request, reply) => {
    const auth = requireAuth(request)
    await rateLimit(services, `verify:${auth.userId}`, 3)
    const [user] = await sql<{ email: string; displayName: string; verified: boolean }[]>`
      select email, display_name as "displayName", email_verified_at is not null as verified
      from app_user where id = ${auth.userId}`
    if (!user) throw notFound('Die Person')
    const body: EmailVerificationRequested = {
      emailEnabled: services.config.SMTP_ENABLED,
      alreadyVerified: user.verified,
    }
    if (user.verified || !services.config.SMTP_ENABLED) return reply.status(202).send(body)
    const { token } = await createToken(sql, {
      userId: auth.userId,
      purpose: 'email_verify',
      email: user.email,
      minutes: VERIFY_HOURS * 60,
    })
    await inTenant(services, auth, (tx) =>
      queueEmail(tx, auth, {
        kind: 'email_verify',
        to: user.email,
        subject: `${appName}: E-Mail-Adresse bestätigen`,
        text: [
          `Hallo ${user.displayName},`,
          '',
          `bitte bestätigen Sie Ihre E-Mail-Adresse für ${appName}:`,
          '',
          `${publicOrigin(services, request)}/email-bestaetigen#${token}`,
          '',
          `Der Link ist ${VERIFY_HOURS} Stunden gültig.`,
        ].join('\n'),
      }),
    )
    return reply.status(202).send(body)
  })

  app.post('/api/v1/auth/email/verify', async (request, reply) => {
    const { token } = parse(accountTokenRequest, request.body)
    await rateLimit(services, `verify-token:ip:${request.ip}`, 30)
    const row = await findToken(sql, token, 'email_verify')
    // Only while the address is still the one the link was sent to.
    if (!row || row.email.toLowerCase() !== row.userEmail.toLowerCase()) {
      throw new HttpError(410, GENERIC_INVALID)
    }
    await sql`update account_token set used_at = now() where id = ${row.id}`
    await sql`update app_user set email_verified_at = coalesce(email_verified_at, now()) where id = ${row.userId}`
    await auditEverywhere(services, row.userId, row.userId, 'email_verified')
    return reply.status(204).send()
  })
}
