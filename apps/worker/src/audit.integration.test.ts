import { createTenant, openTestDb, type TestDb, testDatabaseUrl } from '@easybau/db/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkAuditChains } from './audit.js'

describe.skipIf(!testDatabaseUrl)('nightly audit chain check (integration)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await openTestDb()
  })
  afterAll(async () => {
    await db?.close()
  })

  it('checks every company with the runtime role and logs only problems', async () => {
    const tenant = await createTenant(db, 'Nachtlauf')
    const warnings: unknown[] = []
    const logger = { warn: (o: unknown) => void warnings.push(o), info: () => undefined }
    const results = await checkAuditChains(db.app, logger)
    const own = results.find((r) => r.tenantId === tenant.tenantId)
    expect(own?.problem).toBeNull()
    expect(own?.events).toBeGreaterThan(0)
    expect(warnings).toEqual(
      results
        .filter((r) => r.problem)
        .map((r) => ({ tenantId: r.tenantId, problem: r.problem, seq: r.brokenSeq })),
    )
    const [recorded] = await tenant.run(
      (tx) => tx<{ origin: string }[]>`select origin from audit_chain_check`,
    )
    expect(recorded?.origin).toBe('nightly')
  })
})
