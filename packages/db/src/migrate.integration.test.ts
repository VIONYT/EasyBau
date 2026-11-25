import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql, migrate, type Sql } from './index.js'
import { testDatabaseUrl } from './test-support.js'

describe.skipIf(!testDatabaseUrl)('migration runner (integration)', () => {
  let admin: Sql
  let dir: string
  const table = `schema_migration_test_${Date.now().toString(36)}`.replace(/[0-9]/g, 'x')
  const schema = `${table}_data`

  beforeAll(async () => {
    admin = createSql(
      { DATABASE_URL: testDatabaseUrl as string, DATABASE_POOL_MAX: 4 },
      { mode: 'admin' },
    )
    dir = await mkdtemp(join(tmpdir(), 'easybau-migrations-'))
    await writeFile(
      join(dir, '0001_create.sql'),
      `create schema ${schema}; create table ${schema}.t (id int);`,
    )
    await writeFile(join(dir, '0002_insert.sql'), `insert into ${schema}.t values (1);`)
  })

  afterAll(async () => {
    await admin.unsafe(`drop schema if exists ${schema} cascade; drop table if exists ${table}`)
    await admin.end({ timeout: 5 })
  })

  it('applies pending migrations once, even when started concurrently', async () => {
    const results = await Promise.all([
      migrate(admin, { dir, table }),
      migrate(admin, { dir, table }),
    ])
    const applied = results.flatMap((r) => r.applied)
    expect(applied).toEqual(['0001_create', '0002_insert'])
    const [row] = await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from ${schema}.t`)
    expect(row?.n).toBe(1)
  })

  it('is a no-op when everything is applied', async () => {
    expect(await migrate(admin, { dir, table })).toEqual({ applied: [], alreadyApplied: 2 })
  })

  it('refuses to run when an applied migration was modified', async () => {
    await writeFile(join(dir, '0002_insert.sql'), `insert into ${schema}.t values (2);`)
    await expect(migrate(admin, { dir, table })).rejects.toThrow(/modified after it was applied/)
  })

  it('rolls back a failing migration completely', async () => {
    await writeFile(join(dir, '0002_insert.sql'), `insert into ${schema}.t values (1);`)
    await writeFile(join(dir, '0003_broken.sql'), `insert into ${schema}.t values (3); select 1/0;`)
    await expect(migrate(admin, { dir, table })).rejects.toThrow(/0003_broken failed/)
    const [row] = await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from ${schema}.t`)
    expect(row?.n).toBe(1)
  })

  it('applies the real schema migrations', async () => {
    const result = await migrate(admin)
    expect(result.alreadyApplied + result.applied.length).toBeGreaterThanOrEqual(5)
  })
})
