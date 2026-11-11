import { z } from 'zod'
import { isoDate, listQuery } from './common.js'

/**
 * Änderungsprotokoll (audit log, rule 6) and its hash-chain checks (DESIGN.md §4.7). Read-only;
 * for the company and for the time-limited Prüfer access (GoBD Z1).
 */
export type AuditChainProblem = 'broken' | 'truncated' | 'rewritten'

export interface AuditChainCheck {
  checkedAt: string
  origin: 'nightly' | 'manual'
  checkedBy: string | null
  /** Number of events in the chain. */
  events: number
  /** Null = intact. */
  problem: AuditChainProblem | null
  /** First event where the chain is damaged. */
  brokenSeq: number | null
}

export interface AuditChainStatus {
  last: AuditChainCheck | null
  recent: AuditChainCheck[]
  /** No check in the last 26 hours (nightly job not running). */
  stale: boolean
}

export const auditEventQuery = listQuery.extend({
  entity: z.string().trim().max(60).optional(),
  entityId: z.uuid('Ungültige ID.').optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
})
export type AuditEventQuery = z.infer<typeof auditEventQuery>

export interface AuditEventItem {
  seq: number
  createdAt: string
  actor: string | null
  /** insert | update | delete | login | export:… | role_changed:… */
  action: string
  entity: string
  entityId: string | null
  /** Changed fields (update), all fields (insert/delete); technical columns left out. */
  changes: { field: string; before: unknown; after: unknown }[]
}

export interface AuditEventList {
  items: AuditEventItem[]
  nextCursor: string | null
}
