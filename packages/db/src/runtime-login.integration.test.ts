import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql, ensureRuntimeLogin, runtimeLoginName, type Sql } from './index.js'
import { openTestDb, type TestDb, testDatabaseUrl } from './test-support.js'

const SECRET = 'x'.repeat(40)

describe.skipIf(!testDatabaseUrl)('runtime login without superuser (integration)', () => {
  let db: TestDb
  let runtime: Sql

  beforeAll(async () => {
    db = await openTestDb()
    const url = await ensureRuntimeLogin(db.admin, testDatabaseUrl as string, SECRET)
    // Idempotent: a second start (or a second container) changes nothing.
    expect(await ensureRuntimeLogin(db.admin, testDatabaseUrl as string, SECRET)).toBe(url)
    runtime = createSql({
      DATABASE_URL: testDatabaseUrl as string,
      DATABASE_RUNTIME_URL: url,
      DATABASE_POOL_MAX: 1,
    })
  })

  afterAll(async () => {
    await runtime?.end({ timeout: 5 })
    await db?.close()
  })

  it('logs in as its own role and acts as opc_app', async () => {
    const [row] = await runtime<{ session: string; current: string; superuser: boolean }[]>`
      select session_user as session, current_user as current,
             (select rolsuper from pg_roles where rolname = session_user) as superuser`
    expect(row).toEqual({
      session: runtimeLoginName(testDatabaseUrl as string),
      current: 'opc_app',
      superuser: false,
    })
  })

  it('cannot become the administrator, not even with injected SQL', async () => {
    const adminUser = decodeURIComponent(new URL(testDatabaseUrl as string).username)
    // With the administrator as session user, SET ROLE / SET SESSION AUTHORIZATION would work.
    await expect(runtime.unsafe(`set role "${adminUser}"`)).rejects.toThrow(/permission denied/)
    await expect(runtime.unsafe(`set session authorization "${adminUser}"`)).rejects.toThrow(
      /permission denied/,
    )
  })
})
