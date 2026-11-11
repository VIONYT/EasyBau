import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from './index.js'
import {
  createTenant,
  expectDbError,
  openTestDb,
  type TestDb,
  type TestTenant,
  testDatabaseUrl,
} from './test-support.js'

interface CheckRow {
  origin: string
  events: string
  lastSeq: string | null
  problem: string | null
  brokenSeq: string | null
}

const columns = (sql: Sql) =>
  sql`origin, events, last_seq as "lastSeq", problem, broken_seq as "brokenSeq"`

/**
 * Audit-Kette nachts prüfen (rule 6): every check anchors the newest event, so a chain cut off at
 * the end or recomputed completely is found as well as a changed event.
 */
describe.skipIf(!testDatabaseUrl)('audit chain check (integration)', () => {
  let db: TestDb
  let a: TestTenant
  let b: TestTenant

  /** Runs `tamper` as database administrator and returns the nightly result for tenant a; rolled back. */
  async function tampered(tamper: (tx: Sql) => Promise<unknown>): Promise<CheckRow> {
    return db.admin
      .begin(async (tx) => {
        await tx`alter table audit_event disable trigger trg_audit_immutable`
        await tamper(tx as unknown as Sql)
        await tx`select check_all_audit_chains()`
        const [row] = await tx<CheckRow[]>`
          select ${columns(tx as unknown as Sql)} from audit_chain_check
          where tenant_id = ${a.tenantId} order by checked_at desc limit 1`
        throw Object.assign(new Error('rollback'), { row })
      })
      .catch((error: Error & { row?: CheckRow }) => {
        if (!error.row) throw error
        return error.row
      })
  }

  beforeAll(async () => {
    db = await openTestDb()
    a = await createTenant(db, 'Prüfung A')
    b = await createTenant(db, 'Prüfung B')
  })
  afterAll(async () => {
    await db?.close()
  })

  it('records an intact chain for every company (nightly, runtime role)', async () => {
    const results = await db.app<{ tenantId: string; problem: string | null }[]>`
      select tenant_id as "tenantId", problem from check_all_audit_chains()`
    expect(results.find((r) => r.tenantId === a.tenantId)).toEqual({
      tenantId: a.tenantId,
      problem: null,
    })
    const [row] = await a.run(
      (tx) => tx<CheckRow[]>`
        select ${columns(tx as unknown as Sql)} from audit_chain_check order by checked_at desc limit 1`,
    )
    expect(row?.origin).toBe('nightly')
    expect(row?.problem).toBeNull()
    expect(Number(row?.events)).toBeGreaterThan(0)
    expect(row?.lastSeq).toBe(row?.events)
  })

  it('checks the own company on request; other companies stay invisible', async () => {
    const [own] = await a.run(
      (tx) => tx<{ problem: string | null; origin: string }[]>`
        select problem, origin from check_audit_chain(current_tenant_id(), 'manual', ${a.userId})`,
    )
    expect(own).toEqual({ problem: null, origin: 'manual' })
    // RLS: a check for another company neither reads its events nor writes its result.
    await expectDbError(
      a.run((tx) => tx`select check_audit_chain(${b.tenantId}::uuid, 'manual', null)`),
      /row-level security/,
    )
    const visible = await b.run(
      (tx) => tx`select id from audit_chain_check where origin = 'manual'`,
    )
    expect(visible).toHaveLength(0)
    // Results are never changed.
    await expectDbError(
      a.run((tx) => tx`update audit_chain_check set problem = 'broken'`),
      /permission denied|append-only/,
    )
  })

  it('finds a changed event', async () => {
    const row = await tampered(
      (tx) =>
        tx`update audit_event set after = '{"x":1}' where tenant_id = ${a.tenantId} and seq = 1`,
    )
    expect(row).toMatchObject({ problem: 'broken', brokenSeq: '1' })
  })

  it('finds events deleted at the end of the chain', async () => {
    const row = await tampered(
      (tx) => tx`delete from audit_event where tenant_id = ${a.tenantId}
                 and seq = (select max(seq) from audit_event where tenant_id = ${a.tenantId})`,
    )
    expect(row.problem).toBe('truncated')
  })

  it('finds a chain recomputed completely (hashes no longer match the anchor)', async () => {
    const row = await tampered(async (tx) => {
      await tx`alter table audit_event disable trigger trg_audit_chain`
      await tx`update audit_event set action = 'x' where tenant_id = ${a.tenantId} and seq = 1`
      // Recompute every hash in order, as an attacker with full access could.
      const events = await tx<{ seq: string }[]>`
        select seq::text from audit_event where tenant_id = ${a.tenantId} order by audit_event.seq`
      for (const { seq } of events) {
        await tx`update audit_event e set
                   prev_hash = (select hash from audit_event p where p.tenant_id = e.tenant_id and p.seq = e.seq - 1)
                 where tenant_id = ${a.tenantId} and seq = ${seq}::bigint`
        await tx`update audit_event e set hash = audit_event_hash(e)
                 where tenant_id = ${a.tenantId} and seq = ${seq}::bigint`
      }
    })
    expect(row).toMatchObject({ problem: 'rewritten' })
  })

  it('keeps the last good anchor after a failed check', async () => {
    // All tampering above was rolled back: the chain is intact again.
    const [row] = await a.run(
      (tx) => tx<{ problem: string | null }[]>`
        select problem from check_audit_chain(current_tenant_id(), 'manual', null)`,
    )
    expect(row?.problem).toBeNull()
  })
})
