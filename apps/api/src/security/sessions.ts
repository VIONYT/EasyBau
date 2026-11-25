import { type Sql, withTenant } from '@easybau/db'
import type { Membership } from '@easybau/schemas'
import { randomToken, sha256 } from './crypto.js'

export interface SessionRow {
  id: string
  userId: string
  tenantId: string | null
  mfaVerified: boolean
  email: string
  displayName: string
  totpEnabled: boolean
  webauthnCount: number
}

export interface TenantContext {
  tenantId: string
  tenantName: string
  roleKey: string
  roleName: string
  access: Membership['access']
  permissions: string[]
}

/** Creates a session and returns the raw token for the cookie. Only its SHA-256 is stored. */
export async function createSession(
  sql: Sql,
  input: {
    userId: string
    tenantId: string
    userAgent?: string | undefined
    ttlDays: number
    mfaVerified: boolean
  },
): Promise<string> {
  const token = randomToken()
  await sql`
    insert into user_session (user_id, token_hash, active_tenant_id, user_agent, mfa_verified, expires_at)
    values (${input.userId}, ${sha256(token)}, ${input.tenantId}, ${input.userAgent?.slice(0, 300) ?? null},
            ${input.mfaVerified}, now() + make_interval(days => ${input.ttlDays}))`
  return token
}

/** Looks up a valid session (absolute expiry and idle timeout); refreshes last_seen_at at most every 5 min. */
export async function loadSession(
  sql: Sql,
  token: string,
  idleHours: number,
): Promise<SessionRow | null> {
  const [row] = await sql<(SessionRow & { lastSeenStale: boolean })[]>`
    select s.id, s.user_id as "userId", s.active_tenant_id as "tenantId", s.mfa_verified as "mfaVerified",
           u.email, u.display_name as "displayName", (u.totp_enabled_at is not null) as "totpEnabled",
           (select count(*)::int from webauthn_credential w where w.user_id = u.id) as "webauthnCount",
           (s.last_seen_at < now() - interval '5 minutes') as "lastSeenStale"
    from user_session s
    join app_user u on u.id = s.user_id
    where s.token_hash = ${sha256(token)}
      and s.expires_at > now()
      and s.last_seen_at > now() - make_interval(hours => ${idleHours})
      and u.is_active`
  if (!row) return null
  if (row.lastSeenStale)
    await sql`update user_session set last_seen_at = now() where id = ${row.id}`
  const { lastSeenStale: _, ...session } = row
  return session
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql`delete from user_session where token_hash = ${sha256(token)}`
}

export async function deleteSessionsOfUser(
  sql: Sql,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  await sql`delete from user_session where user_id = ${userId}
            and (${exceptSessionId ?? null}::uuid is null or id <> ${exceptSessionId ?? null}::uuid)`
}

export async function listMemberships(sql: Sql, userId: string): Promise<Membership[]> {
  return sql<Membership[]>`
    select tenant_id as "tenantId", tenant_name as "tenantName", role_key as "roleKey",
           role_name as "roleName", access
    from user_memberships(${userId})`
}

/** Role and permissions of a user inside one tenant (RLS applies), or null if not a member. */
export async function loadTenantContext(
  sql: Sql,
  userId: string,
  tenantId: string,
): Promise<TenantContext | null> {
  const [row] = await withTenant(
    sql,
    { tenantId, userId },
    (tx) => tx<TenantContext[]>`
    select t.id as "tenantId", t.name as "tenantName", r.key as "roleKey", r.name as "roleName",
           r.access, r.permissions
    from membership m
    join role r on r.id = m.role_id
    join tenant t on t.id = m.tenant_id
    where m.user_id = ${userId}
      and (m.valid_until is null or m.valid_until >= current_date)`,
  )
  return row ?? null
}

/** Sliding-window rate limit in PostgreSQL (no Redis, ADR 0002). Keys are hashed (no PII stored). */
export async function hitRateLimit(
  sql: Sql,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const hashed = sha256(key).toString('hex')
  const [row] = await sql<{ hits: number; retry: number }[]>`
    insert into rate_limit (key, window_start, hits) values (${hashed}, now(), 1)
    on conflict (key) do update set
      hits = case when rate_limit.window_start < now() - make_interval(secs => ${windowSeconds})
                  then 1 else rate_limit.hits + 1 end,
      window_start = case when rate_limit.window_start < now() - make_interval(secs => ${windowSeconds})
                          then now() else rate_limit.window_start end
    returning hits,
      greatest(1, ceil(extract(epoch from (window_start + make_interval(secs => ${windowSeconds}) - now()))))::int as retry`
  const hits = row?.hits ?? 1
  return { allowed: hits <= limit, retryAfterSeconds: row?.retry ?? windowSeconds }
}

export async function resetRateLimit(sql: Sql, key: string): Promise<void> {
  await sql`delete from rate_limit where key = ${sha256(key).toString('hex')}`
}
