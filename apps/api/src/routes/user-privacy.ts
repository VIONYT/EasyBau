import type { Sql, Tx } from '@easybau/db'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { inTenant, requireAuth, requirePermission, type Services } from '../context.js'
import { notFound, parse } from '../http.js'
import { todayOf } from './receivables.js'

const userParam = z.object({ userId: z.uuid('Ungültige ID.') })
const TS = `'YYYY-MM-DD HH24:MI'`

/**
 * Datenschutz für Benutzerkonten (DSGVO Art. 15/20): everything stored about a login – the
 * account, sessions and devices, and its data in the current company. The person gets it under
 * „Sicherheit“, the administration under „Benutzer“ (only data of its own company).
 */
async function userReport(sql: Sql, tx: Tx, userId: string): Promise<Record<string, unknown>> {
  const [account] = await sql<Record<string, unknown>[]>`
    select u.display_name as "Name", u.email as "E-Mail",
           to_char(u.created_at at time zone 'Europe/Berlin', ${sql.unsafe(TS)}) as "Angelegt am",
           to_char(u.last_login_at at time zone 'Europe/Berlin', ${sql.unsafe(TS)}) as "Letzte Anmeldung",
           u.email_verified_at is not null as "E-Mail bestätigt",
           u.totp_enabled_at is not null as "Authenticator-App",
           u.is_active as "Aktiv"
    from app_user u where u.id = ${userId}`
  if (!account) throw notFound('Die Person')
  const keys = await sql`
    select name as "Name", to_char(created_at at time zone 'Europe/Berlin', ${sql.unsafe(TS)}) as "Angelegt",
           to_char(last_used_at at time zone 'Europe/Berlin', ${sql.unsafe(TS)}) as "Zuletzt verwendet"
    from webauthn_credential where user_id = ${userId} order by created_at`
  const sessions = await sql`
    select user_agent as "Browser", to_char(created_at at time zone 'Europe/Berlin', ${sql.unsafe(TS)}) as "Seit",
           to_char(last_seen_at at time zone 'Europe/Berlin', ${sql.unsafe(TS)}) as "Zuletzt aktiv"
    from user_session where user_id = ${userId} and expires_at > now() order by created_at`
  const devices = await sql`
    select user_agent as "Browser",
           to_char(first_seen_at at time zone 'Europe/Berlin', ${sql.unsafe(TS)}) as "Erstmals",
           to_char(last_seen_at at time zone 'Europe/Berlin', ${sql.unsafe(TS)}) as "Zuletzt"
    from known_device where user_id = ${userId} order by first_seen_at`
  // Data in the current company (RLS).
  const [membership] = await tx<Record<string, unknown>[]>`
    select t.name as "Firma", r.name as "Rolle",
           to_char(m.valid_until, 'YYYY-MM-DD') as "Zugang bis", w.name as "Lohngruppe",
           to_char(m.created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "Seit"
    from membership m join role r on r.id = m.role_id join tenant t on t.id = m.tenant_id
    left join wage_group w on w.id = m.wage_group_id
    where m.user_id = ${userId}`
  const projects = await tx`
    select p.number as "Nummer", p.name as "Name" from project_member pm
    join project p on p.id = pm.project_id where pm.user_id = ${userId} order by p.name`
  const [counts] = await tx<Record<string, number>[]>`
    select (select count(*)::int from audit_event where actor_user_id = ${userId}) as "Einträge im Änderungsprotokoll",
           (select count(*)::int from notification where user_id = ${userId}) as "Benachrichtigungen",
           (select count(*)::int from report where created_by = ${userId}) as "Angelegte Berichte",
           (select count(*)::int from measurement_line where created_by = ${userId}) as "Erfasste Aufmaßzeilen",
           (select count(*)::int from user_signature where user_id = ${userId}) as "Hinterlegte Unterschrift"`
  return {
    'Auskunft nach Art. 15 DSGVO': {
      'Erstellt am': todayOf(tx),
      Hinweis:
        'Ihr Zugang gilt für alle Firmen, in denen Sie Mitglied sind; die Firmendaten unten betreffen nur diese Firma. Einträge im Änderungsprotokoll werden für die gesetzliche Aufbewahrungsfrist (GoBD) mit Ihrem Namen aufbewahrt.',
    },
    Zugang: account,
    'Sicherheitsschlüssel und Passkeys': keys,
    'Aktive Sitzungen': sessions,
    'Bekannte Geräte': devices,
    Mitgliedschaft: membership ?? null,
    Projekte: projects,
    'Daten in dieser Firma': counts,
  }
}

function sendReport(reply: FastifyReply, report: Record<string, unknown>, date: string) {
  return reply
    .header('content-type', 'application/json; charset=utf-8')
    .header('content-disposition', `attachment; filename="Auskunft_Zugang_${date}.json"`)
    .header('cache-control', 'no-store')
    .send(JSON.stringify(report, null, 2))
}

async function recordReport(tx: Tx, tenantId: string, actorId: string, userId: string) {
  await tx`insert into audit_event (tenant_id, actor_user_id, action, entity, entity_id, hash)
           values (${tenantId}, ${actorId}, 'privacy_report', 'app_user', ${userId}, ''::bytea)`
}

/**
 * A login that no longer belongs to any company: password, second factors, sessions, devices
 * and open links are deleted and the address is replaced. The name stays, because the
 * Änderungsprotokoll must show who changed what for the retention period (GoBD).
 */
export async function eraseOrphanLogin(sql: Sql, userId: string): Promise<boolean> {
  const [left] = await sql<{ n: number }[]>`
    select count(*)::int as n from user_memberships(${userId})`
  if ((left?.n ?? 0) > 0) return false
  await sql`delete from webauthn_credential where user_id = ${userId}`
  await sql`delete from user_session where user_id = ${userId}`
  await sql`delete from known_device where user_id = ${userId}`
  await sql`delete from account_token where user_id = ${userId}`
  await sql`
    update app_user set email = ${`geloescht-${userId}@invalid`}, password_hash = null,
           totp_secret_enc = null, totp_pending_secret_enc = null, totp_enabled_at = null,
           totp_last_step = null, email_verified_at = null, is_active = false
    where id = ${userId}`
  return true
}

export function registerUserPrivacyRoutes(app: FastifyInstance, services: Services) {
  // Own Auskunft (Sicherheit).
  app.get('/api/v1/auth/privacy-report', async (request, reply) => {
    const auth = requireAuth(request)
    const report = await inTenant(services, auth, async (tx) => {
      const data = await userReport(services.sql, tx, auth.userId)
      await recordReport(tx, auth.tenantId, auth.userId, auth.userId)
      return { data, date: todayOf(tx) }
    })
    return sendReport(reply, report.data, report.date)
  })

  // Auskunft for a person of the company (Benutzer).
  app.get('/api/v1/users/:userId/privacy-report', async (request, reply) => {
    const auth = requirePermission(request, 'users.manage')
    const { userId } = parse(userParam, request.params)
    const report = await inTenant(services, auth, async (tx) => {
      const [member] = await tx`select 1 from membership where user_id = ${userId}`
      if (!member) throw notFound('Die Person')
      const data = await userReport(services.sql, tx, userId)
      await recordReport(tx, auth.tenantId, auth.userId, userId)
      return { data, date: todayOf(tx) }
    })
    return sendReport(reply, report.data, report.date)
  })
}
