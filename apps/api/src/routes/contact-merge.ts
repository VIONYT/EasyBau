import type { Tx } from '@easybau/db'
import { type MergeContactResult, mergeContactRequest } from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

interface Party {
  id: string
  kind: 'person' | 'organization'
  number: string | null
  creditorNumber: string | null
  displayName: string
  blocked: boolean
  erased: boolean
  mergedInto: string | null
}

/**
 * Kontakte zusammenführen (Dubletten): moves what may still change from the duplicate to the
 * contact that stays and archives the duplicate with `merged_into_id`. Finalised documents and
 * confirmed incoming invoices keep the duplicate (they carry their own snapshot, rule 2/4).
 */
async function mergeContacts(
  tx: Tx,
  duplicateId: string,
  intoId: string,
): Promise<Omit<MergeContactResult, 'into'>> {
  if (duplicateId === intoId) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      intoId: 'Bitte einen anderen Kontakt wählen.',
    })
  }
  const parties = await tx<Party[]>`
    select id, kind, number, creditor_number as "creditorNumber", display_name as "displayName",
           blocked_at is not null as blocked, erased_at is not null as erased,
           merged_into_id as "mergedInto"
    from contact where id in (${duplicateId}, ${intoId}) order by id for update`
  const duplicate = parties.find((p) => p.id === duplicateId)
  const into = parties.find((p) => p.id === intoId)
  if (!duplicate) throw notFound('Der Kontakt')
  if (!into) {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      intoId: 'Unbekannter Kontakt.',
    })
  }
  for (const p of [duplicate, into]) {
    if (p.blocked || p.erased) {
      throw new HttpError(
        409,
        `„${p.displayName}“ ist aus Datenschutzgründen gesperrt oder gelöscht und kann nicht zusammengeführt werden.`,
      )
    }
    if (p.mergedInto) {
      throw new HttpError(
        409,
        `„${p.displayName}“ wurde bereits mit einem anderen Kontakt zusammengeführt.`,
      )
    }
  }
  if (duplicate.kind !== into.kind) {
    throw new HttpError(
      409,
      'Nur Kontakte derselben Art (Person oder Organisation) lassen sich zusammenführen.',
    )
  }

  const projects =
    await tx`update project set customer_id = ${intoId} where customer_id = ${duplicateId}`
  const documents = await tx`
    update document set
      contact_id = case when contact_id = ${duplicateId} then ${intoId}::uuid else contact_id end,
      contact_person_id = case when contact_person_id = ${duplicateId} then ${intoId}::uuid else contact_person_id end
    where status = 'draft' and (contact_id = ${duplicateId} or contact_person_id = ${duplicateId})`
  const incomingInvoices = await tx`
    update incoming_invoice set contact_id = ${intoId}
    where contact_id = ${duplicateId} and status = 'review'`
  // Ansprechpartner: links of the duplicate the target does not have yet.
  const links = await tx`
    insert into contact_link (tenant_id, person_id, organization_id, role)
    select l.tenant_id,
           case when l.person_id = ${duplicateId} then ${intoId}::uuid else l.person_id end,
           case when l.organization_id = ${duplicateId} then ${intoId}::uuid else l.organization_id end,
           l.role
    from contact_link l
    where (l.person_id = ${duplicateId} or l.organization_id = ${duplicateId})
      and (case when l.person_id = ${duplicateId} then l.organization_id else l.person_id end) <> ${intoId}
    on conflict do nothing`
  await tx`delete from contact_link where person_id = ${duplicateId} or organization_id = ${duplicateId}`
  const channels = await tx`
    update contact_channel c set contact_id = ${intoId}, is_primary = false
    where c.contact_id = ${duplicateId}
      and not exists (select 1 from contact_channel t where t.contact_id = ${intoId}
                      and t.kind = c.kind and lower(t.value) = lower(c.value))`
  await tx`delete from contact_channel where contact_id = ${duplicateId}`
  // Addresses: only kinds the target has none of (a main address stays the target's).
  const addresses = await tx`
    update contact_address a set contact_id = ${intoId}
    where a.contact_id = ${duplicateId}
      and not exists (select 1 from contact_address t where t.contact_id = ${intoId} and t.kind = a.kind)`
  const [kept] = await tx<{ n: number }[]>`
    select (select count(*) from document where contact_id = ${duplicateId} or contact_person_id = ${duplicateId})::int
         + (select count(*) from incoming_invoice where contact_id = ${duplicateId})::int as n`
  // Numbers move to the target if it has none (unique per company: free them first); if both
  // have one, the duplicate keeps its own – its finalised documents carry it anyway.
  if ((duplicate.number && !into.number) || (duplicate.creditorNumber && !into.creditorNumber)) {
    await tx`update contact set number = null, creditor_number = null where id = ${duplicateId}`
    await tx`
      update contact set number = coalesce(number, ${duplicate.number}),
                         creditor_number = coalesce(creditor_number, ${duplicate.creditorNumber})
      where id = ${intoId}`
  }
  await tx`
    update contact set archived_at = coalesce(archived_at, now()), merged_into_id = ${intoId}
    where id = ${duplicateId}`
  return {
    moved: {
      projects: projects.count,
      documents: documents.count,
      incomingInvoices: incomingInvoices.count,
      links: links.count,
      channels: channels.count,
      addresses: addresses.count,
    },
    keptWithDuplicate: kept?.n ?? 0,
  }
}

export function registerContactMergeRoutes(
  app: FastifyInstance,
  services: Services,
  loadContact: (tx: Tx, id: string) => Promise<MergeContactResult['into'] | null>,
) {
  app.post('/api/v1/contacts/:id/merge', async (request): Promise<MergeContactResult> => {
    const auth = requirePermission(request, 'contacts.write')
    const { id } = parse(idParam, request.params)
    const { intoId } = parse(mergeContactRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const result = await mergeContacts(tx, id, intoId)
      await tx`insert into audit_event (tenant_id, actor_user_id, action, entity, entity_id, hash)
               values (${auth.tenantId}, ${auth.userId}, 'contact_merged', 'contact', ${id}, ''::bytea)`
      const into = await loadContact(tx, intoId)
      if (!into) throw notFound('Der Kontakt')
      const { etag: _etag, ...body } = into as MergeContactResult['into'] & { etag?: string }
      return { ...result, into: body }
    })
  })
}
