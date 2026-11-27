import { createHmac } from 'node:crypto'
import type postgres from 'postgres'

/**
 * Own login role for application queries (security audit run-1). Before, the runtime pool logged
 * in with the administrator from DATABASE_URL and only switched to opc_app via the `role` startup
 * parameter – injected SQL could have run RESET ROLE and been superuser. The login role is
 * NOSUPERUSER and NOINHERIT: it can only act as opc_app (RLS), RESET ROLE leaves it without rights.
 * Its password is derived from APP_SECRET, so operators configure nothing.
 */
export function runtimeLoginName(databaseUrl: string): string {
  const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) || 'postgres'
  return `opc_runtime_${database.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 63)
}

function runtimePassword(appSecret: string): string {
  return createHmac('sha256', appSecret).update('easybau-db-runtime-login').digest('hex')
}

/**
 * Creates or updates the login role (admin connection, after the migrations) and returns the
 * connection URL for the runtime pool.
 */
export async function ensureRuntimeLogin(
  admin: postgres.Sql,
  databaseUrl: string,
  appSecret: string,
): Promise<string> {
  const name = runtimeLoginName(databaseUrl)
  const password = runtimePassword(appSecret)
  await admin.begin(async (tx) => {
    // Several containers may start at once; roles are cluster-wide.
    await tx`select pg_advisory_xact_lock(hashtext('easybau.runtime_login'))`
    const [exists] = await tx`select 1 from pg_roles where rolname = ${name}`
    const statement = exists
      ? 'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE PASSWORD %L'
      : 'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE PASSWORD %L'
    const [sql] = await tx<
      { text: string }[]
    >`select format(${statement}::text, ${name}::text, ${password}::text) as text`
    await tx.unsafe((sql as { text: string }).text)
    const [grant] = await tx<{ text: string }[]>`
      select format('GRANT opc_app TO %I', ${name}::text) as text`
    await tx.unsafe((grant as { text: string }).text)
    const [connect] = await tx<{ text: string }[]>`
      select format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), ${name}::text) as text`
    await tx.unsafe((connect as { text: string }).text)
  })
  const url = new URL(databaseUrl)
  url.username = encodeURIComponent(name)
  url.password = password
  return url.toString()
}
