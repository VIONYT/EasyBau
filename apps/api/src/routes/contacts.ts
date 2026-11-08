import type { Tx } from '@opc/db'
import {
  type ContactDetail,
  type ContactSummary,
  contactListQuery,
  createContactRequest,
  linkContactRequest,
  type Page,
  type UpdateContactRequest,
  updateContactRequest,
} from '@opc/schemas'
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
    await tx`delete from contact_address where contact_id = ${contactId}`
    for (const a of input.addresses) {
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
           einvoice_email as "einvoiceEmail", einvoice_format as "einvoiceFormat",
           updated_at as "updatedRaw", to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt",
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
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

export function registerContactRoutes(app: FastifyInstance, services: Services) {
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
        and (${query.color ?? null}::text is null or c.color = ${query.color ?? null})
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
      const columns = {
        ...columnsOf(input),
        tenant_id: auth.tenantId,
        kind: input.kind,
        number: number?.n ?? null,
        created_by: auth.userId,
      }
      const [row] = await tx<{ id: string }[]>`insert into contact ${tx(columns)} returning id`
      const id = (row as { id: string }).id
      await replaceChildren(tx, auth.tenantId, id, input)
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
        }[]
      >`
        select kind, updated_at as "updatedAt", organization_name as "organizationName",
               first_name as "firstName", last_name as "lastName"
        from contact where id = ${id} for update`
      if (!current) throw notFound('Der Kontakt')
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
      if (Object.keys(columns).length) await tx`update contact set ${tx(columns)} where id = ${id}`
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
        update contact set archived_at = ${archived ? tx`now()` : null} where id = ${id}`,
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
