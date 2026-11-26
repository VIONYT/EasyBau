import { withTenant } from '@easybau/db'
import { addDays, germanDate } from '@easybau/domain'
import {
  acceptInvitationRequest,
  type InvitationInfo,
  type InvitationSummary,
  type InviteResponse,
  inviteRequest,
  type LoginResponse,
  type MemberSummary,
  type RoleSummary,
  updateMemberRequest,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inTenant, publicOrigin, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { randomToken, sha256 } from '../security/crypto.js'
import { audit, finishLogin, rateLimit } from './auth-common.js'
import { queueEmail } from './email.js'
import { todayOf } from './receivables.js'
import { noticeTime, securityNotice } from './security-notices.js'
import { eraseOrphanLogin, registerUserPrivacyRoutes } from './user-privacy.js'

const userParam = z.object({ userId: z.uuid('Ungültige ID.') })
const idParam = z.object({ id: z.uuid('Ungültige ID.') })
// The token travels in the body, never in the URL, so it does not end up in access logs.
const tokenBody = z.object({ token: z.string().min(20).max(100) })
const INVITATION_DAYS = 7
const INVITATION_INVALID = 'Die Einladung ist ungültig, abgelaufen oder wurde bereits verwendet.'

/** Auditors (Prüfer) only get access for a limited time; at most one year ahead. */
function checkAccessUntil(
  roleKey: string,
  until: string | null | undefined,
  today: string,
  field: 'accessUntil' | 'validUntil',
) {
  if (roleKey === 'auditor' && !until) {
    throw new HttpError(400, 'Für Prüfer ist ein Enddatum des Zugangs Pflicht.', {
      [field]: 'Bitte ein Enddatum angeben.',
    })
  }
  if (!until) return
  if (until < today) {
    throw new HttpError(400, 'Das Enddatum liegt in der Vergangenheit.', {
      [field]: 'Datum liegt in der Vergangenheit.',
    })
  }
  if (until > addDays(today, 366)) {
    throw new HttpError(400, 'Der Zugang kann höchstens ein Jahr im Voraus befristet werden.', {
      [field]: 'Höchstens ein Jahr.',
    })
  }
}

function lastAdminError(error: unknown): never {
  if (error instanceof Error && /last admin/.test(error.message)) {
    throw new HttpError(409, 'Die Firma braucht mindestens einen Admin.')
  }
  throw error
}

export function registerUserRoutes(app: FastifyInstance, services: Services) {
  registerUserPrivacyRoutes(app, services)
  const { sql } = services

  app.get('/api/v1/roles', async (request): Promise<RoleSummary[]> => {
    const auth = requirePermission(request, 'users.manage')
    return inTenant(
      services,
      auth,
      (tx) => tx<RoleSummary[]>`
      select id, key, name, access, is_system as "isSystem", permissions from role
      order by case key when 'admin' then 0 when 'office_lead' then 1 when 'project_lead' then 2
                        when 'team_lead' then 3 when 'team_member' then 4 else 5 end, name`,
    )
  })

  app.get('/api/v1/users', async (request): Promise<MemberSummary[]> => {
    const auth = requirePermission(request, 'users.manage')
    return inTenant(
      services,
      auth,
      (tx) => tx<MemberSummary[]>`
      select u.id as "userId", u.display_name as "displayName", u.email,
             json_build_object('key', r.key, 'name', r.name, 'access', r.access) as role,
             (u.totp_enabled_at is not null) as "totpEnabled",
             (select count(*)::int from webauthn_credential w where w.user_id = u.id) as "webauthnCount",
             to_char(u.last_login_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastLoginAt",
             (u.id = ${auth.userId}) as "isSelf",
             to_char(m.valid_until, 'YYYY-MM-DD') as "validUntil",
             coalesce(m.valid_until < current_date, false) as expired
      from membership m
      join app_user u on u.id = m.user_id
      join role r on r.id = m.role_id
      order by lower(u.display_name)`,
    )
  })

  app.patch('/api/v1/users/:userId', async (request, reply) => {
    const auth = requirePermission(request, 'users.manage')
    const { userId } = parse(userParam, request.params)
    const input = parse(updateMemberRequest, request.body)
    if (userId === auth.userId)
      throw new HttpError(409, 'Die eigene Rolle und den eigenen Zugang ändern Sie nicht selbst.')
    const roleKey = await inTenant(services, auth, async (tx) => {
      const [member] = await tx<{ roleKey: string; validUntil: string | null }[]>`
        select r.key as "roleKey", to_char(m.valid_until, 'YYYY-MM-DD') as "validUntil"
        from membership m join role r on r.id = m.role_id where m.user_id = ${userId}`
      if (!member) throw notFound('Die Person')
      const nextRole = input.roleKey ?? member.roleKey
      const [role] = await tx<{ id: string }[]>`select id from role where key = ${nextRole}`
      if (!role) throw new HttpError(400, 'Unbekannte Rolle.', { roleKey: 'Unbekannte Rolle.' })
      const validUntil = input.validUntil !== undefined ? input.validUntil : member.validUntil
      if (input.validUntil !== undefined || nextRole !== member.roleKey) {
        checkAccessUntil(nextRole, validUntil, todayOf(tx), 'validUntil')
      }
      await tx`update membership set role_id = ${role.id}, valid_until = ${validUntil}::date
               where user_id = ${userId}`.catch(lastAdminError)
      return nextRole
    })
    if (input.roleKey) {
      await audit(services, auth.tenantId, auth.userId, `role_changed:${roleKey}`, userId)
    }
    if (input.validUntil !== undefined) {
      await audit(
        services,
        auth.tenantId,
        auth.userId,
        `access_until:${input.validUntil ?? 'unlimited'}`,
        userId,
      )
    }
    return reply.status(204).send()
  })

  // Removes the person from the company (the login itself stays for other companies).
  app.delete('/api/v1/users/:userId', async (request, reply) => {
    const auth = requirePermission(request, 'users.manage')
    const { userId } = parse(userParam, request.params)
    if (userId === auth.userId) throw new HttpError(409, 'Sie können sich nicht selbst entfernen.')
    await inTenant(services, auth, async (tx) => {
      await tx`delete from project_member where user_id = ${userId}`
      const deleted = await tx`delete from membership where user_id = ${userId}`.catch(
        lastAdminError,
      )
      if (!deleted.count) throw notFound('Die Person')
    })
    await sql`delete from user_session where user_id = ${userId} and active_tenant_id = ${auth.tenantId}`
    await audit(services, auth.tenantId, auth.userId, 'member_removed', userId)
    // DSGVO: a login without any company keeps only its name (Änderungsprotokoll).
    if (await eraseOrphanLogin(sql, userId)) {
      await audit(services, auth.tenantId, auth.userId, 'login_erased', userId)
    }
    return reply.status(204).send()
  })

  // Lost phone / key: an admin resets the second factors – only for logins that belong to
  // this company alone, so no company can weaken the security of another one.
  app.post('/api/v1/users/:userId/reset-mfa', async (request, reply) => {
    const auth = requirePermission(request, 'users.manage')
    const { userId } = parse(userParam, request.params)
    if (userId === auth.userId)
      throw new HttpError(409, 'Die eigenen Faktoren verwalten Sie unter „Sicherheit“.')
    const [member] = await inTenant(
      services,
      auth,
      (tx) => tx`select 1 from membership where user_id = ${userId}`,
    )
    if (!member) throw notFound('Die Person')
    const [other] = await sql<
      { n: number }[]
    >`select count(*)::int as n from user_memberships(${userId})`
    if ((other?.n ?? 0) > 1) {
      throw new HttpError(
        409,
        'Diese Person gehört zu mehreren Firmen. Sie muss ihre Faktoren selbst zurücksetzen lassen.',
      )
    }
    await sql`update app_user set totp_secret_enc = null, totp_pending_secret_enc = null, totp_enabled_at = null,
              totp_last_step = null where id = ${userId}`
    await sql`delete from webauthn_credential where user_id = ${userId}`
    await sql`delete from user_session where user_id = ${userId}`
    await audit(services, auth.tenantId, auth.userId, 'mfa_reset', userId)
    await securityNotice(services, userId, 'Zweiter Faktor zurückgesetzt', [
      `${auth.displayName} hat am ${noticeTime()} alle zweiten Faktoren Ihrer Anmeldung bei ${services.config.APP_NAME} entfernt (Authenticator-App, Sicherheitsschlüssel, Passkeys). Alle Sitzungen wurden beendet; bitte richten Sie nach der nächsten Anmeldung wieder einen zweiten Faktor ein.`,
      '',
      'Wenn Sie das nicht veranlasst haben, wenden Sie sich bitte sofort an die Administration Ihrer Firma.',
    ])
    return reply.status(204).send()
  })

  // --- Einladungen -------------------------------------------------------------------------------

  app.get('/api/v1/invitations', async (request): Promise<InvitationSummary[]> => {
    const auth = requirePermission(request, 'users.manage')
    return inTenant(
      services,
      auth,
      (tx) => tx<InvitationSummary[]>`
      select i.id, i.email, i.display_name as "displayName",
             json_build_object('key', r.key, 'name', r.name) as role,
             to_char(i.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
             to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
             to_char(i.access_until, 'YYYY-MM-DD') as "accessUntil"
      from invitation i join role r on r.id = i.role_id
      where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
      order by i.created_at desc`,
    )
  })

  app.post('/api/v1/invitations', async (request, reply): Promise<InviteResponse> => {
    const auth = requirePermission(request, 'users.manage')
    const input = parse(inviteRequest, request.body)
    const token = randomToken()
    const invitation = await inTenant(services, auth, async (tx) => {
      const [role] = await tx<{ id: string }[]>`select id from role where key = ${input.roleKey}`
      if (!role) throw new HttpError(400, 'Unbekannte Rolle.', { roleKey: 'Unbekannte Rolle.' })
      checkAccessUntil(input.roleKey, input.accessUntil, todayOf(tx), 'accessUntil')
      const [member] = await tx`
        select 1 from membership m join app_user u on u.id = m.user_id where lower(u.email) = ${input.email}`
      if (member)
        throw new HttpError(409, 'Diese Person gehört bereits zur Firma.', {
          email: 'Bereits Mitglied.',
        })
      // A new invitation replaces an open one for the same address.
      await tx`update invitation set revoked_at = now()
               where lower(email) = ${input.email} and accepted_at is null and revoked_at is null`
      const [row] = await tx<InvitationSummary[]>`
        with inserted as (
          insert into invitation (tenant_id, email, display_name, role_id, token_hash, invited_by, expires_at,
                                  access_until)
          values (${auth.tenantId}, ${input.email}, ${input.displayName ?? null}, ${role.id}, ${sha256(token)},
                  ${auth.userId}, now() + make_interval(days => ${INVITATION_DAYS}),
                  ${input.accessUntil ?? null}::date)
          returning *)
        select i.id, i.email, i.display_name as "displayName",
               json_build_object('key', r.key, 'name', r.name) as role,
               to_char(i.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
               to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
               to_char(i.access_until, 'YYYY-MM-DD') as "accessUntil"
        from inserted i join role r on r.id = i.role_id`
      const summary = row as InvitationSummary
      const acceptUrl = `${publicOrigin(services, request)}/einladung#${token}`
      const emailQueued = Boolean(input.sendEmail && services.config.SMTP_ENABLED)
      if (emailQueued) {
        await queueEmail(tx, auth, {
          kind: 'invitation',
          to: input.email,
          subject: `Einladung zu ${auth.tenantName}`,
          text: [
            `Hallo${input.displayName ? ` ${input.displayName}` : ''},`,
            '',
            `${auth.displayName} lädt Sie zu ${auth.tenantName} ein (Rolle: ${summary.role.name}).`,
            'Über diesen Link legen Sie Ihr Passwort fest und melden sich an:',
            '',
            acceptUrl,
            '',
            `Der Link ist ${INVITATION_DAYS} Tage gültig und nur einmal verwendbar.`,
            ...(input.accessUntil
              ? [`Ihr Zugang ist befristet bis ${germanDate(input.accessUntil)}.`]
              : []),
            'Wenn Sie diese Einladung nicht erwartet haben, ignorieren Sie die E-Mail einfach.',
          ].join('\n'),
        })
      }
      return { summary, acceptUrl, emailQueued }
    })
    reply.status(201)
    return {
      invitation: invitation.summary,
      acceptUrl: invitation.acceptUrl,
      emailQueued: invitation.emailQueued,
    }
  })

  app.delete('/api/v1/invitations/:id', async (request, reply) => {
    const auth = requirePermission(request, 'users.manage')
    const { id } = parse(idParam, request.params)
    const updated = await inTenant(
      services,
      auth,
      (tx) => tx`
      update invitation set revoked_at = now() where id = ${id} and accepted_at is null and revoked_at is null`,
    )
    if (!updated.count) throw notFound('Die Einladung')
    return reply.status(204).send()
  })

  // --- Einladung annehmen (öffentlich, über den Token im Link) ---------------------------------------

  async function openInvitation(token: string) {
    const [row] = await sql<
      {
        id: string
        tenantId: string
        tenantName: string
        email: string
        displayName: string | null
        roleName: string
        expired: boolean
        closed: boolean
      }[]
    >`select id, tenant_id as "tenantId", tenant_name as "tenantName", email, display_name as "displayName",
             role_name as "roleName", expired, closed
      from invitation_by_token(${sha256(token)})`
    if (!row || row.expired || row.closed) throw new HttpError(404, INVITATION_INVALID)
    return row
  }

  app.post('/api/v1/invitations/lookup', async (request): Promise<InvitationInfo> => {
    await rateLimit(services, `invitation:${request.ip}`, 30)
    const { token } = parse(tokenBody, request.body)
    const invitation = await openInvitation(token)
    const [existing] = await sql`select 1 from app_user where lower(email) = ${invitation.email}`
    return {
      tenantName: invitation.tenantName,
      email: invitation.email,
      displayName: invitation.displayName,
      roleName: invitation.roleName,
      existingAccount: !!existing,
    }
  })

  app.post('/api/v1/invitations/accept', async (request, reply): Promise<LoginResponse> => {
    await rateLimit(services, `invitation:${request.ip}`, 30)
    const { token } = parse(tokenBody, request.body)
    const input = parse(acceptInvitationRequest.extend(tokenBody.shape), request.body)
    const invitation = await openInvitation(token)

    const [existing] = await sql<{ id: string; passwordHash: string | null }[]>`
      select id, password_hash as "passwordHash" from app_user where lower(email) = ${invitation.email}`
    let userId: string
    if (existing) {
      // Existing login: joining another company requires its password (no account takeover).
      if (
        !existing.passwordHash ||
        !(await services.passwords.verify(existing.passwordHash, input.password))
      ) {
        throw new HttpError(403, 'Das Passwort Ihres bestehenden Zugangs ist falsch.', {
          password: 'Passwort ist falsch.',
        })
      }
      userId = existing.id
    } else {
      const displayName = input.displayName ?? invitation.displayName
      if (!displayName)
        throw new HttpError(400, 'Bitte Ihren Namen angeben.', { displayName: 'Pflichtfeld.' })
      const [created] = await sql<{ id: string }[]>`
        insert into app_user (email, display_name, password_hash, email_verified_at)
        values (${invitation.email}, ${displayName}, ${await services.passwords.hash(input.password)}, now())
        returning id`
      userId = (created as { id: string }).id
    }

    await withTenant(sql, { tenantId: invitation.tenantId, userId }, async (tx) => {
      const [locked] = await tx`
        update invitation set accepted_at = now(), accepted_by = ${userId}
        where id = ${invitation.id} and accepted_at is null and revoked_at is null and expires_at > now()
        returning role_id, access_until`
      if (!locked) throw new HttpError(404, INVITATION_INVALID)
      await tx`insert into membership (tenant_id, user_id, role_id, valid_until)
               values (${invitation.tenantId}, ${userId}, ${locked.role_id}, ${locked.access_until})
               on conflict (tenant_id, user_id) do nothing`
    })
    // A login with second factors set up must still use them: no shortcut via invitations.
    const [factors] = await sql<{ n: number }[]>`
      select (case when totp_enabled_at is null then 0 else 1 end +
              (select count(*) from webauthn_credential where user_id = ${userId}))::int as n
      from app_user where id = ${userId}`
    if ((factors?.n ?? 0) > 0) {
      reply.status(202)
      return { status: 'mfa_required', methods: [] }
    }
    return finishLogin(services, request, reply, {
      userId,
      requestedTenantId: invitation.tenantId,
      mfaVerified: false,
      method: 'invitation',
    })
  })
}
