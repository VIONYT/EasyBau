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

function derivedPassword(appSecret: string, purpose: string): string {
  return createHmac('sha256', appSecret).update(`easybau-db-${purpose}-login`).digest('hex')
}

function databaseName(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) || 'postgres'
}

function withLogin(databaseUrl: string, name: string, password: string): string {
  const url = new URL(databaseUrl)
  url.username = encodeURIComponent(name)
  url.password = password
  return url.toString()
}

/** Creates the login role or brings it to the expected attributes and password. */
async function upsertLogin(tx: postgres.TransactionSql, name: string, password: string) {
  const [exists] = await tx`select 1 from pg_roles where rolname = ${name}`
  const statement = exists
    ? 'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE PASSWORD %L'
    : 'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE PASSWORD %L'
  await execFormat(tx, statement, name, password)
  await execFormat(tx, 'GRANT CONNECT ON DATABASE %I TO %I', null, name)
}

/** Runs a statement built with format() (identifiers/literals cannot be bind parameters). */
async function execFormat(
  tx: postgres.TransactionSql,
  statement: string,
  first: string | null,
  second?: string,
) {
  const [row] =
    first === null
      ? await tx<{ text: string }[]>`
          select format(${statement}::text, current_database(), ${second ?? ''}::text) as text`
      : await tx<{ text: string }[]>`
          select format(${statement}::text, ${first}::text, ${second ?? ''}::text) as text`
  await tx.unsafe((row as { text: string }).text)
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
  const password = derivedPassword(appSecret, 'runtime')
  await admin.begin(async (tx) => {
    // Several containers may start at once; roles are cluster-wide.
    await tx`select pg_advisory_xact_lock(hashtext('easybau.runtime_login'))`
    await upsertLogin(tx, name, password)
    await execFormat(tx, 'GRANT opc_app TO %I', name)
  })
  return withLogin(databaseUrl, name, password)
}

/** Login of the job queue (pg-boss), owner of its schema only. */
export function jobsLoginName(databaseUrl: string): string {
  return `opc_jobs_${databaseName(databaseUrl)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')}`.slice(0, 63)
}

/**
 * The job queue no longer runs as administrator either (ADR 0013): its own login owns the schema
 * `jobs` and everything in it (existing objects are handed over) and has no rights on company data.
 */
export async function ensureJobsLogin(
  admin: postgres.Sql,
  databaseUrl: string,
  appSecret: string,
  schema = 'jobs',
): Promise<string> {
  const name = jobsLoginName(databaseUrl)
  const password = derivedPassword(appSecret, 'jobs')
  await admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('easybau.runtime_login'))`
    await upsertLogin(tx, name, password)
    const [exists] = await tx`select 1 from pg_namespace where nspname = ${schema}`
    if (!exists) {
      await execFormat(tx, 'CREATE SCHEMA %I AUTHORIZATION %I', schema, name)
      return
    }
    await execFormat(tx, 'ALTER SCHEMA %I OWNER TO %I', schema, name)
    const objects = await tx<{ statement: string }[]>`
      select format('ALTER %s %s OWNER TO %I',
               case c.relkind when 'S' then 'SEQUENCE' when 'v' then 'VIEW' else 'TABLE' end,
               c.oid::regclass, ${name}::text) as statement
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema} and c.relkind in ('r', 'p', 'S', 'v')
        and pg_get_userbyid(c.relowner) <> ${name}
      union all
      select format('ALTER %s %s OWNER TO %I',
               case p.prokind when 'p' then 'PROCEDURE' else 'FUNCTION' end,
               p.oid::regprocedure, ${name}::text)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${schema} and pg_get_userbyid(p.proowner) <> ${name}
      union all
      select format('ALTER TYPE %s OWNER TO %I', t.oid::regtype, ${name}::text)
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = ${schema} and t.typtype in ('e', 'c', 'd') and t.typrelid = 0
        and pg_get_userbyid(t.typowner) <> ${name}`
    for (const { statement } of objects) await tx.unsafe(statement)
  })
  return withLogin(databaseUrl, name, password)
}
