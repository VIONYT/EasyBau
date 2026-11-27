import { createSql, ensureJobsLogin, jobsLoginName } from '@easybau/db'
import { openTestDb, type TestDb, testDatabaseUrl } from '@easybau/db/test-support'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SECRET = 'j'.repeat(40)

/** ADR 0013: the job queue runs with its own login that owns only the schema `jobs`. */
describe.skipIf(!testDatabaseUrl)('job queue login (integration)', () => {
  let db: TestDb
  let url: string
  let jobsUrl: string

  beforeAll(async () => {
    db = await openTestDb({ isolated: true })
    url = db.url
    // An existing installation: the queue schema was created by the administrator.
    const before = new PgBoss({ connectionString: url, schema: 'jobs' })
    await before.start()
    await before.createQueue('heartbeat')
    await before.stop({ graceful: false })
    jobsUrl = await ensureJobsLogin(db.admin, url, SECRET)
  })

  afterAll(async () => {
    await db?.close()
  })

  it('takes over the schema and keeps working', async () => {
    const boss = new PgBoss({ connectionString: jobsUrl, schema: 'jobs', max: 2 })
    try {
      await boss.start()
      await boss.createQueue('heartbeat')
      await boss.createQueue('neu')
      const id = await boss.send('neu', { n: 1 })
      const [job] = await boss.fetch<{ n: number }>('neu')
      expect(job?.id).toBe(id)
      expect(job?.data).toEqual({ n: 1 })
    } finally {
      await boss.stop({ graceful: false })
    }
  })

  it('has no rights on company data and is no superuser', async () => {
    const jobs = createSql({ DATABASE_URL: jobsUrl, DATABASE_POOL_MAX: 1 }, { mode: 'admin' })
    try {
      const [row] = await jobs<{ name: string; superuser: boolean }[]>`
        select session_user as name, (select rolsuper from pg_roles where rolname = session_user) as superuser`
      expect(row).toEqual({ name: jobsLoginName(url), superuser: false })
      await expect(jobs`select count(*) from tenant`).rejects.toThrow(/permission denied/)
    } finally {
      await jobs.end({ timeout: 5 })
    }
  })
})
