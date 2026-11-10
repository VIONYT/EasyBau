import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tx } from './index.js'
import {
  createDraftInvoice,
  createProject,
  createTenant,
  expectDbError,
  openTestDb,
  type TestDb,
  testDatabaseUrl,
} from './test-support.js'

/** Nummernkreise: schema, counter per year, never a number twice (CLAUDE.md rule 3). */
describe.skipIf(!testDatabaseUrl)('number sequences (integration)', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await openTestDb()
  })

  afterAll(async () => {
    await db?.close()
  })

  const next = async (tx: Tx, kind: string, date: string) =>
    (await tx<{ n: string }[]>`select next_number(${kind}, ${date}::date) as n`)[0]?.n

  it('formats the number by its schema, year before or after the running number', async () => {
    const t = await createTenant(db)
    await t.run(async (tx) => {
      expect(await next(tx, 'invoice', '2026-11-09')).toBe('R-00101')
      await tx`update number_sequence set pattern = 'R{Jahr}-{Nummer}' where kind = 'invoice'`
      expect(await next(tx, 'invoice', '2026-11-09')).toBe('R2026-00102')
      await tx`update number_sequence set pattern = 'R{Nummer}-{Jahr}' where kind = 'invoice'`
      expect(await next(tx, 'invoice', '2026-11-09')).toBe('R00103-2026')
      await tx`update number_sequence set pattern = 'RE{jj}{Monat}/{FortlaufendeNummer}', min_length = 2
               where kind = 'invoice'`
      expect(await next(tx, 'invoice', '2027-02-01')).toBe('RE2702/104')
      // Numbers longer than the minimum length are never cut.
      await tx`update number_sequence set pattern = '{Nummer}', min_length = 1, next_value = 123456
               where kind = 'quote'`
      expect(await next(tx, 'quote', '2026-11-09')).toBe('123456')
      await expectDbError(
        tx.savepoint(
          (sp) => sp`update number_sequence set pattern = 'R-{Jahr}' where kind = 'invoice'`,
        ),
        /number_sequence_pattern_check/,
      )
    })
  })

  it('keeps one counter per year, so backdated invoices never collide', async () => {
    const t = await createTenant(db)
    await t.run(async (tx) => {
      await tx`update number_sequence set pattern = 'R{Jahr}-{Nummer}', reset_yearly = true,
               start_value = 1, min_length = 3 where kind = 'invoice'`
      expect(await next(tx, 'invoice', '2026-12-30')).toBe('R2026-001')
      expect(await next(tx, 'invoice', '2026-12-31')).toBe('R2026-002')
      expect(await next(tx, 'invoice', '2027-01-02')).toBe('R2027-001')
      // An invoice dated December, finalized in January: next number of 2026, not R2026-001 again.
      expect(await next(tx, 'invoice', '2026-12-31')).toBe('R2026-003')
      expect(await next(tx, 'invoice', '2027-01-03')).toBe('R2027-002')
      const years = await tx<{ year: number; next: string }[]>`
        select year, next_value::text as next from number_sequence_year where kind = 'invoice' order by year`
      expect(years).toEqual([
        { year: 2026, next: '4' },
        { year: 2027, next: '3' },
      ])
      await expectDbError(
        tx.savepoint(
          (sp) =>
            sp`update number_sequence_year set next_value = 1 where kind = 'invoice' and year = 2026`,
        ),
        /must not be decreased/,
      )
      await expectDbError(
        tx.savepoint((sp) => sp`delete from number_sequence_year where kind = 'invoice'`),
        /must not be deleted/,
      )
      // Turning the yearly restart off continues after the highest counter.
      await tx`update number_sequence set reset_yearly = false where kind = 'invoice'`
      expect(await next(tx, 'invoice', '2027-01-04')).toBe('R2027-101')
    })
  })

  it('skips numbers that are already in use instead of issuing them twice', async () => {
    const t = await createTenant(db)
    await t.run(async (tx) => {
      const { projectId } = await createProject(tx, t.tenantId)
      const invoice = await createDraftInvoice(tx, t.tenantId, projectId)
      await tx`update document set number = 'R-00101', status = 'finalized', finalized_at = now(),
                 content_hash = sha256('x'::bytea), recipient_snapshot = '{}', issuer_snapshot = '{}'
               where id = ${invoice.documentId}`
      // The counter still says 101 (e.g. after an import or a changed schema).
      expect(await next(tx, 'invoice', '2026-11-09')).toBe('R-00102')
      // Credit notes and invoices share one number space.
      await tx`update number_sequence set pattern = 'R-{Nummer}', next_value = 101 where kind = 'credit_note'`
      expect(await next(tx, 'credit_note', '2026-11-09')).toBe('R-00102')
    })
  })

  it('issues gapless, unique numbers under concurrency', async () => {
    const t = await createTenant(db)
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => t.run((tx) => next(tx, 'invoice', '2026-11-09'))),
    )
    expect(new Set(numbers).size).toBe(20)
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `R-${String(101 + i).padStart(5, '0')}`),
    )
  })
})
