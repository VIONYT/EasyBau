import { type Sql, withTenant } from '@easybau/db'
import type { Logger } from 'pino'

/**
 * Löschkonzept (DSGVO Art. 17/18): contacts blocked until the end of their retention period are
 * erased (anonymised) the day after it ended. All companies; idempotent.
 */
export async function eraseExpiredContacts(
  sql: Sql,
  logger: Pick<Logger, 'info'>,
): Promise<number> {
  const due = await sql<{ tenantId: string; contactId: string }[]>`
    select tenant_id as "tenantId", contact_id as "contactId" from contacts_due_for_erasure()`
  let erased = 0
  for (const { tenantId, contactId } of due) {
    const done = await withTenant(sql, { tenantId }, async (tx) => {
      const [row] = await tx<{ erased: boolean }[]>`select erase_contact(${contactId}) as erased`
      if (!row?.erased) return false
      await tx`insert into audit_event (tenant_id, action, entity, entity_id, hash)
               values (${tenantId}, 'privacy_erase', 'contact', ${contactId}, ''::bytea)`
      return true
    })
    if (done) erased += 1
  }
  logger.info({ erased }, 'blocked contacts erased after their retention period')
  return erased
}
