import type { Config } from '@easybau/config'
import type { Sql, Tx } from '@easybau/db'
import { withTenant } from '@easybau/db'
import type { ArchiveStore, ObjectStore } from '@easybau/storage'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { forbidden, HttpError } from './http.js'
import type { EinvoiceValidator } from './kosit.js'
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
    | 'APP_NAME'
    | 'SESSION_TTL_DAYS'
    | 'SESSION_IDLE_HOURS'
    | 'COOKIE_SECURE'
    | 'REQUIRE_ADMIN_MFA'
    | 'UPLOAD_MAX_MB'
  > & {
    PUBLIC_URL?: string | undefined
    /** SMTP configured: e-mails are queued in the outbox and sent by the worker. */
    SMTP_ENABLED: boolean
    SMTP_FROM?: string | undefined
    /** Rechnungseingang per E-Mail allowed by the operator (INCOMING_MAIL_ENABLED). */
    INCOMING_MAIL_ENABLED?: boolean
    /** KoSIT validator (ADR 0007), for the Betriebs-Check. */
    KOSIT_URL?: string | undefined
  }
  /** Uploaded files (project filing, ADR 0004). */
  storage: ObjectStore
  /** Checks every e-invoice before an invoice is finalized (rule 8); null = not configured. */
  einvoiceValidator: EinvoiceValidator | null
  /** WORM archive of document originals (ADR 0008); null = only the files volume. */
  archive: ArchiveStore | null
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
/** Services of a running transaction, e.g. to decrypt fields deep inside loaders. */
const transactionServices = new WeakMap<object, Services>()

export function servicesOf(tx: Tx): Services | undefined {
  return transactionServices.get(tx)
}

export function inTenant<T>(
  services: Services,
  /** A logged-in person, or a system process (e-mail inbox) with `userId: null`. */
  auth: Pick<AuthContext, 'tenantId'> & { userId: string | null },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTenant(
    services.sql,
    { tenantId: auth.tenantId, userId: auth.userId ?? undefined },
    (tx) => {
      transactionServices.set(tx, services)
      return fn(tx)
    },
  )
}

export type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

/** Users without `project.read_all` only see projects they are a member of (DESIGN.md §5.2). */
export function projectVisibility(tx: Tx, auth: AuthContext, alias = 'p') {
  return auth.permissions.has('project.read_all')
    ? tx`true`
    : tx`exists (select 1 from project_member pm where pm.project_id = ${tx(alias)}.id and pm.user_id = ${auth.userId})`
}

/** Loads a project the user may see (404 otherwise, also for other tenants thanks to RLS). */
export async function requireVisibleProject(
  tx: Tx,
  auth: AuthContext,
  projectId: string,
): Promise<{ id: string; archived: boolean }> {
  const [row] = await tx<{ id: string; archived: boolean }[]>`
    select p.id, (p.archived_at is not null) as archived from project p
    where p.id = ${projectId} and ${projectVisibility(tx, auth)}`
  if (!row) throw new HttpError(404, 'Das Projekt wurde nicht gefunden.')
  return row
}
