import type { Config } from '@easybau/config'
import postgres from 'postgres'

export type Sql = postgres.Sql
export type Tx = postgres.TransactionSql

export { MIGRATIONS_DIR, type MigrateOptions, type MigrationResult, migrate } from './migrate.js'
export {
  ensureJobsLogin,
  ensureRuntimeLogin,
  jobsLoginName,
  runtimeLoginName,
} from './runtime-login.js'

/**
 * Restricted runtime role created by migration 0001. It is no superuser and has no BYPASSRLS,
 * so row level security always applies to application queries (CLAUDE.md rule 5).
 */
export const RUNTIME_ROLE = 'opc_app'

export interface CreateSqlOptions {
  /**
   * `runtime` (default): every connection switches to RUNTIME_ROLE.
   * `admin`: keeps the login role; only for migrations and the job queue schema.
   */
  mode?: 'runtime' | 'admin'
}

/** Creates a connection pool. Pool size is small on purpose (compact profile, ADR 0002). */
export function createSql(
  config: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_MAX'> &
    Partial<Pick<Config, 'DATABASE_RUNTIME_URL'>>,
  { mode = 'runtime' }: CreateSqlOptions = {},
): Sql {
  // Runtime connections use their own non-superuser login when there is one (runtime-login.ts):
  // then even injected SQL could not RESET ROLE to a superuser.
  const url =
    mode === 'runtime' ? (config.DATABASE_RUNTIME_URL ?? config.DATABASE_URL) : config.DATABASE_URL
  return postgres(url, {
    max: config.DATABASE_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 5,
    onnotice: () => {},
    ...(mode === 'runtime' ? { connection: { role: RUNTIME_ROLE } } : {}),
  })
}

export interface TenantContext {
  tenantId: string
  /** Acting user, recorded in the audit log. */
  userId?: string | undefined
}

/**
 * Runs `fn` in a transaction scoped to one tenant. RLS policies read `app.tenant_id`;
 * the audit trigger reads `app.user_id`. Both settings are transaction-local.
 */
export async function withTenant<T>(
  sql: Sql,
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${context.tenantId}, true),
                    set_config('app.user_id', ${context.userId ?? ''}, true)`
    return fn(tx)
  })
  return result as T
}

/** Readiness probe: true if the database answers within the timeout. */
export async function pingDatabase(sql: Sql, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('database ping timeout')), timeoutMs)
    })
    await Promise.race([sql`select 1`, timeout])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Removes the working copies of anonymised originals (ADR 0012); the WORM copy is the operator's
 * task. A copy that cannot be deleted stays pending (Löschprotokoll) and is retried next time.
 */
export async function deletePurgedWorkingCopies(
  sql: Sql,
  context: TenantContext,
  files: { delete(key: string): Promise<void> },
): Promise<void> {
  const rows = await withTenant(
    sql,
    context,
    (tx) => tx<{ artifactId: string; storageKey: string }[]>`
      select artifact_id as "artifactId", storage_key as "storageKey"
      from artifact_purge where file_deleted_at is null order by purged_at limit 1000`,
  )
  const done: string[] = []
  for (const row of rows) {
    try {
      await files.delete(row.storageKey)
      done.push(row.artifactId)
    } catch {
      // stays pending
    }
  }
  if (done.length) {
    await withTenant(
      sql,
      context,
      (tx) => tx`update artifact_purge set file_deleted_at = now()
                 where artifact_id in ${tx(done)} and file_deleted_at is null`,
    )
  }
}
