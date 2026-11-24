/**
 * Löschkonzept (DSGVO Art. 17/18, DESIGN.md §9): a contact named in tax-relevant records must be
 * kept until their retention period ends (§ 147 AO, § 257 HGB) – until then it is blocked
 * (restricted processing), afterwards erased. Without such records it is erased at once.
 */
export type ErasureAction = { action: 'erase' } | { action: 'block'; until: string }

/** `retentionEnd` and `today` as ISO dates (YYYY-MM-DD); the last day of the period still counts. */
export function erasureAction(retentionEnd: string | null, today: string): ErasureAction {
  if (retentionEnd === null || retentionEnd < today) return { action: 'erase' }
  return { action: 'block', until: retentionEnd }
}
