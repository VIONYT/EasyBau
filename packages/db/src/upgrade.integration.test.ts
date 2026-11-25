import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createSql, MIGRATIONS_DIR, migrate, type Sql } from './index.js'
import { ensureAppRole, testDatabaseUrl } from './test-support.js'

/**
 * Upgrade test of the migrations (CLAUDE.md „Migrationen … vorwärtskompatibel“): a database with
 * real data of an older version is brought to the current schema.
 *
 * Each fixture `fixtures/upgrade-NNNN.sql` is a data dump of a database at migration NNNN, filled
 * through the API (apps/api/src/upgrade-fixture.generate.integration.test.ts). The test applies the
 * migrations up to NNNN, loads the data, applies all newer migrations and then checks:
 * - no table lost rows,
 * - the audit chain of every firm is still intact,
 * - the schema equals that of a database migrated from scratch.
 */
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url))
const FIXTURE = /^upgrade-(\d{4})\.sql$/

const fixtures = (await readdir(FIXTURES_DIR).catch(() => [] as string[]))
  .map((file) => ({ file, version: Number(FIXTURE.exec(file)?.[1]) }))
  .filter((f) => Number.isInteger(f.version))

describe.skipIf(!testDatabaseUrl || fixtures.length === 0)(
  'migration upgrade with data (integration)',
  () => {
    const root = createSql(
      { DATABASE_URL: testDatabaseUrl as string, DATABASE_POOL_MAX: 1 },
      {
        mode: 'admin',
      },
    )
    const created: string[] = []

    afterAll(async () => {
      for (const name of created) await root.unsafe(`drop database if exists ${name} with (force)`)
      await root.end({ timeout: 5 })
    })

    async function database(label: string): Promise<{ sql: Sql; url: string }> {
      const name = `easybau_upgrade_${label}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
      await root.unsafe(`create database ${name}`)
      created.push(name)
      await ensureAppRole(root)
      const url = new URL(testDatabaseUrl as string)
      url.pathname = `/${name}`
      return {
        sql: createSql({ DATABASE_URL: url.toString(), DATABASE_POOL_MAX: 2 }, { mode: 'admin' }),
        url: url.toString(),
      }
    }

    /** Migrations up to `version` in a separate directory (released migrations never change). */
    async function migrationsUpTo(version: number): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'easybau-migrations-'))
      for (const file of await readdir(MIGRATIONS_DIR)) {
        if (Number(file.slice(0, 4)) <= version)
          await copyFile(join(MIGRATIONS_DIR, file), join(dir, file))
      }
      return dir
    }

    const tables = async (sql: Sql) =>
      (
        await sql<{ name: string }[]>`
        select tablename as name from pg_tables
        where schemaname = 'public' and tablename <> 'schema_migration' order by tablename`
      ).map((t) => t.name)

    async function rowCounts(sql: Sql): Promise<Record<string, number>> {
      const counts: Record<string, number> = {}
      for (const table of await tables(sql)) {
        const [row] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from "${table}"`)
        counts[table] = row?.n ?? 0
      }
      return counts
    }

    /** Columns, constraints, indexes, triggers, functions and policies – order independent. */
    async function schemaOf(sql: Sql): Promise<string[]> {
      const rows = await sql<{ item: string }[]>`
      select 'column ' || table_name || '.' || column_name || ' ' || data_type || ' '
             || is_nullable || ' ' || coalesce(column_default, '') as item
        from information_schema.columns where table_schema = 'public'
      union all
      select 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
        from pg_constraint where connamespace = 'public'::regnamespace
      union all
      select 'index ' || indexdef from pg_indexes where schemaname = 'public'
      union all
      select 'trigger ' || tgrelid::regclass || ' ' || tgname || ' ' || tgenabled::text
        from pg_trigger where not tgisinternal
          and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
      union all
      select 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
             || md5(pg_get_functiondef(p.oid))
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
      union all
      select 'policy ' || tablename || ' ' || policyname || ' ' || coalesce(qual, '') || ' '
             || coalesce(with_check, '')
        from pg_policies where schemaname = 'public'
      union all
      select 'rls ' || relname || ' ' || relrowsecurity || ' ' || relforcerowsecurity
        from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`
      return rows.map((r) => r.item).sort()
    }

    for (const fixture of fixtures) {
      it(`upgrades a database with data from migration ${fixture.version}`, async () => {
        const { sql, url } = await database(String(fixture.version))
        const dir = await migrationsUpTo(fixture.version)
        try {
          await migrate(sql, { dir })
          // Migrations seed system rows (roles, units, base interest rates); the dump has them too.
          const names = (await tables(sql)).map((t) => `"${t}"`).join(', ')
          // Only in this empty test database: the append-only triggers forbid TRUNCATE (rule 6).
          await sql.begin(async (tx) => {
            await tx.unsafe('set local session_replication_role = replica')
            await tx.unsafe(`truncate ${names} restart identity cascade`)
          })

          const dump = (await readFile(join(FIXTURES_DIR, fixture.file), 'utf8'))
            .split('\n')
            .filter((line) => !line.startsWith('\\')) // psql meta commands (\restrict) of pg_dump 17.6+
            .join('\n')
          const loader = createSql({ DATABASE_URL: url, DATABASE_POOL_MAX: 1 }, { mode: 'admin' })
          try {
            await loader.unsafe(dump)
          } finally {
            await loader.end({ timeout: 5 })
          }

          const before = await rowCounts(sql)
          expect(before.tenant, 'fixture loaded').toBeGreaterThan(0)
          expect(before.document).toBeGreaterThan(0)

          await migrate(sql)

          const after = await rowCounts(sql)
          for (const [table, count] of Object.entries(before)) {
            if (table in after)
              expect(after[table], `rows of ${table}`).toBeGreaterThanOrEqual(count)
          }
          const problems = await sql<{ tenantId: string; problem: string | null }[]>`
          select tenant_id as "tenantId", problem from check_all_audit_chains()`
          expect(problems.length).toBe(before.tenant)
          expect(problems.filter((p) => p.problem !== null)).toEqual([])

          const fresh = await database('fresh')
          try {
            await migrate(fresh.sql)
            expect(await schemaOf(sql)).toEqual(await schemaOf(fresh.sql))
          } finally {
            await fresh.sql.end({ timeout: 5 })
          }
        } finally {
          await sql.end({ timeout: 5 })
          await rm(dir, { recursive: true, force: true })
        }
      }, 120_000)
    }
  },
)
