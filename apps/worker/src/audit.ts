import type { Sql } from '@easybau/db'
import type { Logger } from 'pino'

export interface AuditCheckResult {
  tenantId: string
  events: number
  problem: 'broken' | 'truncated' | 'rewritten' | null
  brokenSeq: number | null
}

/**
 * Audit-Kette nachts prüfen (rule 6): checks the hash chain of every company and records the
 * result (shown in the Betriebs-Check). Idempotent: a second run only adds another check.
 */
export async function checkAuditChains(
  sql: Sql,
  logger: Pick<Logger, 'warn' | 'info'>,
): Promise<AuditCheckResult[]> {
  const rows = await sql<
    {
      tenantId: string
      events: string
      problem: AuditCheckResult['problem']
      brokenSeq: string | null
    }[]
  >`select tenant_id as "tenantId", events::text, problem, broken_seq::text as "brokenSeq"
    from check_all_audit_chains()`
  const results = rows.map((r) => ({
    tenantId: r.tenantId,
    events: Number(r.events),
    problem: r.problem,
    brokenSeq: r.brokenSeq === null ? null : Number(r.brokenSeq),
  }))
  for (const r of results.filter((x) => x.problem)) {
    // Only ids and positions, no content of the events (rule 9).
    logger.warn(
      { tenantId: r.tenantId, problem: r.problem, seq: r.brokenSeq },
      'audit chain check failed',
    )
  }
  logger.info(
    { companies: results.length, failed: results.filter((r) => r.problem).length },
    'audit chains checked',
  )
  return results
}
