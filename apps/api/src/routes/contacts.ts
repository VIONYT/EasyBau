import type { Tx } from '@easybau/db'
import {
  type ContactColor,
  type ContactDetail,
  type ContactSummary,
  type CreateContactRequest,
  contactListQuery,
  createContactRequest,
  linkContactRequest,
  type Page,
  type UpdateContactRequest,
  updateContactRequest,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inTenant, requirePermission, type Services } from '../context.js'
import {
  checkIfMatch,
  decodeCursor,
  encodeCursor,
  etagOf,
  HttpError,
  notFound,
  parse,
} from '../http.js'
import { registerContactMergeRoutes } from './contact-merge.js'

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

/** Columns that map 1:1 from request (camelCase) to the contact table (snake_case). */
const SIMPLE_FIELDS: Record<string, string> = {
  organizationName: 'organization_name',
  salutation: 'salutation',
  title: 'title',
  firstName: 'first_name',
  lastName: 'last_name',
  website: 'website',
  color: 'color',
  description: 'description',
  paymentTermId: 'payment_term_id',
  taxMode: 'tax_mode',
  vatId: 'vat_id',
  buyerReference: 'buyer_reference',
  creditorNumber: 'creditor_number',
  einvoiceEmail: 'einvoice_email',
  einvoiceFormat: 'einvoice_format',
}

function columnsOf(input: UpdateContactRequest): Record<string, unknown> {
  const columns: Record<string, unknown> = {}
  for (const [field, column] of Object.entries(SIMPLE_FIELDS)) {
    const value = (input as Record<string, unknown>)[field]
    if (value !== undefined) columns[column] = value
  }
  return columns
}

async function replaceChildren(
  tx: Tx,
  tenantId: string,
  contactId: string,
  input: UpdateContactRequest,
) {
  if (input.channels) {
    await tx`delete from contact_channel where contact_id = ${contactId}`
    for (const c of input.channels) {
      await tx`insert into contact_channel (tenant_id, contact_id, kind, value, label, is_primary)
               values (${tenantId}, ${contactId}, ${c.kind}, ${c.value}, ${c.label}, ${c.isPrimary})`
    }
  }
  if (input.addresses) {
    // Addresses keep their id (documents may refer to one); missing ones are removed.
    const keep = input.addresses.map((a) => a.id).filter((v): v is string => Boolean(v))
    await tx`delete from contact_address where contact_id = ${contactId}
             and (${keep.length === 0} or id <> all(${keep}::uuid[]))`
    for (const a of input.addresses) {
      const [updated] = a.id
        ? await tx`
            update contact_address set kind = ${a.kind}, recipient_block = ${a.recipientBlock ?? null},
              street = ${a.street ?? null}, street_extra = ${a.streetExtra ?? null},
              postal_code = ${a.postalCode ?? null}, city = ${a.city ?? null}, country_code = ${a.countryCode}
            where id = ${a.id} and contact_id = ${contactId} returning id`
        : []
      if (updated) continue
      await tx`insert into contact_address (tenant_id, contact_id, kind, recipient_block, street, street_extra,
                                            postal_code, city, country_code)
               values (${tenantId}, ${contactId}, ${a.kind}, ${a.recipientBlock ?? null}, ${a.street ?? null},
                       ${a.streetExtra ?? null}, ${a.postalCode ?? null}, ${a.city ?? null}, ${a.countryCode})`
    }
  }
}

async function loadContact(tx: Tx, id: string): Promise<(ContactDetail & { etag: string }) | null> {
  const [c] = await tx<
    (Omit<ContactDetail, 'channels' | 'addresses' | 'links' | 'projects'> & { updatedRaw: Date })[]
  >`
    select id, kind, number, display_name as "displayName", color, (archived_at is not null) as archived,
           organization_name as "organizationName", salutation, title, first_name as "firstName",
           last_name as "lastName", website, description, payment_term_id as "paymentTermId",
           tax_mode as "taxMode", vat_id as "vatId", buyer_reference as "buyerReference",
           creditor_number as "creditorNumber", einvoice_email as "einvoiceEmail", einvoice_format as "einvoiceFormat",
           updated_at as "updatedRaw", to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt",
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
           to_char(blocked_until, 'YYYY-MM-DD') as "blockedUntil",
           to_char(erased_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "erasedAt",
           (select json_build_object('id', m.id, 'displayName', m.display_name)
              from contact m where m.id = contact.merged_into_id) as "mergedInto"
    from contact where id = ${id}`
  if (!c) return null
  const channels = await tx<ContactDetail['channels']>`
    select id, kind, value, label, is_primary as "isPrimary" from contact_channel
    where contact_id = ${id} order by is_primary desc, kind, value`
  const addresses = await tx<ContactDetail['addresses']>`
    select id, kind, recipient_block as "recipientBlock", street, street_extra as "streetExtra",
           postal_code as "postalCode", city, country_code as "countryCode"
    from contact_address where contact_id = ${id} order by kind`
  const links = await tx<ContactDetail['links']>`
    select other.id as "contactId", other.display_name as "displayName", other.kind, l.role
    from contact_link l
    join contact other on other.id = case when l.person_id = ${id} then l.organization_id else l.person_id end
    where l.person_id = ${id} or l.organization_id = ${id}
    order by other.display_name`
  const projects = await tx<ContactDetail['projects']>`
    select id, number, name, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"
    from project where customer_id = ${id} order by updated_at desc limit 50`
  const { updatedRaw, ...rest } = c
  return { ...rest, channels, addresses, links, projects, etag: etagOf(updatedRaw) }
}

/** DSGVO: blocked (until the end of the retention period) or erased contacts stay as they are. */
export function restrictedContact(): HttpError {
  return new HttpError(
    409,
    'Der Kontakt ist aus Datenschutzgründen gesperrt oder gelöscht und kann nicht mehr geändert oder verwendet werden.',
  )
}

/** Usable for new projects and documents: exists, not blocked, not erased, not merged away. */
export async function usableContact(tx: Tx, id: string): Promise<boolean> {
  return (
    (
      await tx`select 1 from contact where id = ${id} and blocked_at is null and erased_at is null
                 and merged_into_id is null`
    ).length > 0
  )
}

export function mergedContact(): HttpError {
  return new HttpError(
    409,
    'Der Kontakt wurde mit einem anderen zusammengeführt und kann nicht mehr geändert werden.',
  )
}

/** Unique Kreditorennummer per company. */
function creditorTaken(error: { code?: string; constraint_name?: string }): never {
  if (error.code === '23505' && error.constraint_name === 'contact_creditor_number_uq') {
    throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
      creditorNumber: 'Diese Kreditorennummer ist schon vergeben.',
    })
  }
  throw error
}

/** Inserts a contact with channels and addresses; `number` is the Kundennummer (or none). */
export async function insertContact(
  tx: Tx,
  auth: { tenantId: string; userId: string },
  input: CreateContactRequest,
  number: string | null,
): Promise<string> {
  const columns = {
    ...columnsOf(input),
    tenant_id: auth.tenantId,
    kind: input.kind,
    number,
    created_by: auth.userId,
  }
  const [row] = await tx<{ id: string }[]>`insert into contact ${tx(columns)} returning id`.catch(
    creditorTaken,
  )
  const id = (row as { id: string }).id
  await replaceChildren(tx, auth.tenantId, id, input)
  return id
}

export function registerContactRoutes(app: FastifyInstance, services: Services) {
  registerContactMergeRoutes(app, services, loadContact)
  // Farben in Gebrauch (Farbfilter der Kontaktliste).
  app.get('/api/v1/contacts/colors', async (request): Promise<ContactColor[]> => {
    const auth = requirePermission(request, 'contacts.read')
    return inTenant(
      services,
      auth,
      (tx) => tx<ContactColor[]>`
        select lower(color) as color, count(*)::int as count from contact
        where color is not null and archived_at is null
        group by lower(color) order by count(*) desc, lower(color) limit 50`,
    )
  })

  app.get('/api/v1/contacts', async (request): Promise<Page<ContactSummary>> => {
    const auth = requirePermission(request, 'contacts.read')
    const query = parse(contactListQuery, request.query)
    const cursor = decodeCursor(query.cursor, 2)
    const search = query.q ? `%${query.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%` : null
    const rows = await inTenant(
      services,
      auth,
      (tx) => tx<(ContactSummary & { sortKey: string })[]>`
      select c.id, c.kind, c.number, c.display_name as "displayName", c.color,
             (c.archived_at is not null) as archived, lower(c.display_name) as "sortKey",
             to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt",
             (select value from contact_channel ch where ch.contact_id = c.id and ch.kind = 'email'
              order by ch.is_primary desc limit 1) as "primaryEmail",
             (select value from contact_channel ch where ch.contact_id = c.id and ch.kind in ('phone', 'mobile')
              order by ch.is_primary desc limit 1) as "primaryPhone",
             (select city from contact_address a where a.contact_id = c.id order by (a.kind = 'main') desc limit 1) as city
      from contact c
      where (c.archived_at is not null) = ${query.archived === 'true'}
        and (${query.kind ?? null}::text is null or c.kind = ${query.kind ?? null})
        and (${query.color ?? null}::text is null or lower(c.color) = lower(${query.color ?? null}))
        and (${query.customer ?? null}::text is null or (c.number is not null) = ${query.customer === 'true'})
        and (${search}::text is null
             or lower(c.display_name) like ${search}
             or lower(coalesce(c.number, '')) like ${search}
             or exists (select 1 from contact_channel ch where ch.contact_id = c.id and lower(ch.value) like ${search})
             or exists (select 1 from contact_address a where a.contact_id = c.id
                        and lower(concat_ws(' ', a.street, a.postal_code, a.city)) like ${search}))
        and (${cursor ? String(cursor[0]) : null}::text is null
             or (lower(c.display_name), c.id) > (${cursor ? String(cursor[0]) : ''}, ${cursor ? String(cursor[1]) : '00000000-0000-0000-0000-000000000000'}::uuid))
      order by lower(c.display_name), c.id
      limit ${query.limit + 1}`,
    )
    const more = rows.length > query.limit
    const items = rows.slice(0, query.limit)
    const last = items.at(-1)
    return {
      items: items.map(({ sortKey: _, ...item }) => item),
      nextCursor: more && last ? encodeCursor([last.sortKey, last.id]) : null,
    }
  })

  app.post('/api/v1/contacts', async (request, reply) => {
    const auth = requirePermission(request, 'contacts.write')
    const input = parse(createContactRequest, request.body)
    const contact = await inTenant(services, auth, async (tx) => {
      const [number] = input.assignCustomerNumber
        ? await tx<{ n: string }[]>`select next_number('contact') as n`
        : [{ n: null }]
      const id = await insertContact(tx, auth, input, number?.n ?? null)
      return loadContact(tx, id)
    })
    const { etag, ...body } = contact as ContactDetail & { etag: string }
    return reply
      .status(201)
      .header('etag', etag)
      .header('location', `/api/v1/contacts/${body.id}`)
      .send(body)
  })

  app.get('/api/v1/contacts/:id', async (request, reply) => {
    const auth = requirePermission(request, 'contacts.read')
    const { id } = parse(idParam, request.params)
    const contact = await inTenant(services, auth, (tx) => loadContact(tx, id))
    if (!contact) throw notFound('Der Kontakt')
    const { etag, ...body } = contact
    return reply.header('etag', etag).send(body)
  })

  app.patch('/api/v1/contacts/:id', async (request, reply) => {
    const auth = requirePermission(request, 'contacts.write')
    const { id } = parse(idParam, request.params)
    const input = parse(updateContactRequest, request.body)
    const contact = await inTenant(services, auth, async (tx) => {
      const [current] = await tx<
        {
          kind: string
          updatedAt: Date
          organizationName: string | null
          firstName: string | null
          lastName: string | null
          restricted: boolean
          merged: boolean
        }[]
      >`
        select kind, updated_at as "updatedAt", organization_name as "organizationName",
               first_name as "firstName", last_name as "lastName",
               (blocked_at is not null or erased_at is not null) as restricted,
               merged_into_id is not null as merged
        from contact where id = ${id} for update`
      if (!current) throw notFound('Der Kontakt')
      if (current.merged) throw mergedContact()
      if (current.restricted) throw restrictedContact()
      checkIfMatch(request.headers['if-match'], current.updatedAt)
      const merged = { ...current, ...input }
      if (current.kind === 'organization' && !merged.organizationName) {
        throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
          organizationName: 'Bitte den Namen der Organisation angeben.',
        })
      }
      if (current.kind === 'person' && !merged.firstName && !merged.lastName) {
        throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', {
          lastName: 'Bitte Vor- oder Nachnamen angeben.',
        })
      }
      const columns = columnsOf(input)
      if (Object.keys(columns).length)
        await tx`update contact set ${tx(columns)} where id = ${id}`.catch(creditorTaken)
      else await tx`update contact set updated_at = now() where id = ${id}`
      await replaceChildren(tx, auth.tenantId, id, input)
      return loadContact(tx, id)
    })
    const { etag, ...body } = contact as ContactDetail & { etag: string }
    return reply.header('etag', etag).send(body)
  })

  for (const [action, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const) {
    app.post(`/api/v1/contacts/:id/${action}`, async (request, reply) => {
      const auth = requirePermission(request, 'contacts.write')
      const { id } = parse(idParam, request.params)
      const updated = await inTenant(
        services,
        auth,
        (tx) => tx`
        update contact set archived_at = ${archived ? tx`now()` : null}
        where id = ${id} and blocked_at is null and erased_at is null and merged_into_id is null`,
      )
      if (!updated.count) throw notFound('Der Kontakt')
      return reply.status(204).send()
    })
  }

  // Deleting is only possible while the contact is not used anywhere (rule 7: otherwise archive).
  app.delete('/api/v1/contacts/:id', async (request, reply) => {
    const auth = requirePermission(request, 'contacts.write')
    const { id } = parse(idParam, request.params)
    await inTenant(services, auth, async (tx) => {
      const [usage] = await tx<{ used: boolean }[]>`
        select exists (select 1 from project where customer_id = ${id})
            or exists (select 1 from document where contact_id = ${id} or contact_person_id = ${id}) as used`
      if (usage?.used) {
        throw new HttpError(
          409,
          'Der Kontakt wird in Projekten oder Dokumenten verwendet. Bitte archivieren statt löschen.',
        )
      }
      const deleted = await tx`delete from contact where id = ${id}`
      if (!deleted.count) throw notFound('Der Kontakt')
    })
    return reply.status(204).send()
  })

  app.post('/api/v1/contacts/:id/links', async (request, reply) => {
    const auth = requirePermission(request, 'contacts.write')
    const { id } = parse(idParam, request.params)
    const input = parse(linkContactRequest, request.body)
    await inTenant(services, auth, async (tx) => {
      const rows = await tx<{ id: string; kind: string }[]>`
        select id, kind from contact where id in (${id}, ${input.organizationId})`
      const person = rows.find((r) => r.id === id)
      const organization = rows.find((r) => r.id === input.organizationId)
      if (!person || !organization) throw notFound('Der Kontakt')
      if (person.kind !== 'person' || organization.kind !== 'organization') {
        throw new HttpError(400, 'Es kann nur eine Person mit einer Organisation verknüpft werden.')
      }
      await tx`insert into contact_link (tenant_id, person_id, organization_id, role)
               values (${auth.tenantId}, ${id}, ${input.organizationId}, ${input.role ?? null})
               on conflict (person_id, organization_id) do update set role = excluded.role`
    })
    return reply.status(204).send()
  })

  app.delete('/api/v1/contacts/:id/links/:otherId', async (request, reply) => {
    const auth = requirePermission(request, 'contacts.write')
    const { id, otherId } = parse(
      idParam.extend({ otherId: z.uuid('Ungültige ID.') }),
      request.params,
    )
    await inTenant(
      services,
      auth,
      (tx) => tx`
      delete from contact_link
      where (person_id = ${id} and organization_id = ${otherId}) or (person_id = ${otherId} and organization_id = ${id})`,
    )
    return reply.status(204).send()
  })
}
