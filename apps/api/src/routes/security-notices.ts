import { type Sql, withTenant } from '@opc/db'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthContext, Services } from '../context.js'
import { randomToken, sha256 } from '../security/crypto.js'
import { queueEmail } from './email.js'

/** Security notices to a person's own address (Konto): password changed, new device, address changed. */

/** Mails go out in the name of the person's first company (outbox, footer, reply-to). */
async function firstTenantOf(
  sql: Sql,
  userId: string,
): Promise<{ tenantId: string; tenantName: string } | null> {
  const [row] = await sql<{ tenantId: string; tenantName: string }[]>`
    select tenant_id as "tenantId", tenant_name as "tenantName" from user_memberships(${userId}) limit 1`
  return row ?? null
}

export async function mail(
  services: Services,
  userId: string,
  kind: 'password_reset' | 'email_verify' | 'email_change' | 'security_notice',
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

/**
 * Security notice to the person's own address (password changed, new device, address changed).
 * Only with SMTP; sent in the name of the person's first company.
 */
export async function securityNotice(
  services: Services,
  userId: string,
  subject: string,
  lines: string[],
  to?: string,
): Promise<boolean> {
  if (!services.config.SMTP_ENABLED) return false
  const [user] = await services.sql<{ email: string; displayName: string }[]>`
    select email, display_name as "displayName" from app_user where id = ${userId}`
  if (!user) return false
  return mail(
    services,
    userId,
    'security_notice',
    to ?? user.email,
    `${services.config.APP_NAME}: ${subject}`,
    [`Hallo ${user.displayName},`, '', ...lines].join('\n'),
  )
}

/** Berlin time for notices, e.g. „25.11.2026, 10:15 Uhr“. */
export function noticeTime(date = new Date()): string {
  return `${new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  }).format(date)} Uhr`
}

export const NOT_YOU =
  'Wenn Sie das nicht waren, ändern Sie bitte sofort Ihr Passwort (oder nutzen Sie „Passwort vergessen“) und informieren Sie die Administration Ihrer Firma.'

export async function passwordChangedNotice(services: Services, userId: string) {
  await securityNotice(services, userId, 'Ihr Passwort wurde geändert', [
    `das Passwort Ihrer Anmeldung bei ${services.config.APP_NAME} wurde am ${noticeTime()} geändert. Alle anderen Sitzungen wurden beendet.`,
    '',
    NOT_YOU,
  ])
}

const DEVICE_COOKIE_DAYS = 400
const deviceCookieName = (secure: boolean) => (secure ? '__Host-device' : 'device')

/** Short description of the browser for the notice (no full user agent in the mail). */
export function deviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'unbekanntes Gerät'
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser'
  const system = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null
  return system ? `${browser} auf ${system}` : browser
}

/**
 * Recognises the device by a long-lived random cookie (only its SHA-256 is stored). A login from
 * a device the person has not used before sends a notice – except for the very first device.
 * Returns true for a new device.
 */
export async function rememberDevice(
  services: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<boolean> {
  const secure = services.config.COOKIE_SECURE
  const name = deviceCookieName(secure)
  const current = request.cookies?.[name]
  const token = current && /^[A-Za-z0-9_-]{43}$/.test(current) ? current : randomToken(32)
  const hash = sha256(token)
  const userAgent = request.headers['user-agent']?.slice(0, 500) ?? null
  const known = await services.sql`
    update known_device set last_seen_at = now(), user_agent = ${userAgent}
    where user_id = ${userId} and device_hash = ${hash}`
  reply.setCookie(name, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_COOKIE_DAYS * 24 * 3600,
  })
  if (known.count) return false
  const [before] = await services.sql<{ n: number }[]>`
    select count(*)::int as n from known_device where user_id = ${userId}`
  await services.sql`
    insert into known_device (user_id, device_hash, user_agent) values (${userId}, ${hash}, ${userAgent})
    on conflict do nothing`
  if (!before?.n) return false
  await securityNotice(services, userId, 'Anmeldung von einem neuen Gerät', [
    `am ${noticeTime()} hat sich jemand mit Ihrem Zugang bei ${services.config.APP_NAME} von einem Gerät angemeldet, das bisher nicht verwendet wurde (${deviceLabel(request.headers['user-agent'])}).`,
    '',
    NOT_YOU,
  ])
  return true
}
