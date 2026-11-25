import type { Tx } from '@easybau/db'
import { csv, parseCsv } from '@easybau/exports'
import {
  CONTACT_CSV_COLUMNS,
  type ContactImportResult,
  type ContactImportRow,
  type CreateContactRequest,
  contactListQuery,
  createContactRequest,
  importContactsRequest,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, parse } from '../http.js'
import { insertContact } from './contacts.js'
import { todayIn } from './receivables.js'

/**
 * Kontakte als CSV (P2.9): Export of the (filtered) list and import with preview. Columns:
 * CONTACT_CSV_COLUMNS (German headers, semicolon, UTF-8 with BOM for Excel).
 */

const TAX_LABELS: Record<NonNullable<CreateContactRequest['taxMode']>, string> = {
  standard: 'Regelbesteuerung',
  reverse_charge_13b: '§ 13b UStG',
  small_business: 'Kleinunternehmer',
  intra_eu: 'innergemeinschaftlich',
  export: 'Ausfuhr',
}

const MAX_ROWS = 5000

/** Header aliases (lower case, without spaces/dots/hyphens) → column. */
const normalize = (header: string) =>
  header
    .toLowerCase()
    .replace(/[\s.\-_]/g, '')
    .replace('ß', 'ss')
const ALIASES: Record<string, (typeof CONTACT_CSV_COLUMNS)[number]> = {
  ...Object.fromEntries(CONTACT_CSV_COLUMNS.map((c) => [normalize(c), c])),
  art: 'Typ',
  kundennr: 'Kundennummer',
  nummer: 'Kundennummer',
  name: 'Firma',
  organisation: 'Firma',
  unternehmen: 'Firma',
  email: 'E-Mail',
  mail: 'E-Mail',
  telefonnummer: 'Telefon',
  handy: 'Mobil',
  mobiltelefon: 'Mobil',
  strasse: 'Straße',
  postleitzahl: 'PLZ',
  stadt: 'Ort',
  ustid: 'USt-IdNr.',
  ustidnr: 'USt-IdNr.',
  umsatzsteueridentifikationsnummer: 'USt-IdNr.',
  leitwegid: 'Leitweg-ID',
  erechnungemail: 'E-Mail für E-Rechnungen',
  notiz: 'Beschreibung',
  bemerkung: 'Beschreibung',
}

function taxModeOf(value: string): CreateContactRequest['taxMode'] {
  const v = value.trim().toLowerCase()
  if (!v) return undefined
  const found = Object.entries(TAX_LABELS).find(
    ([key, label]) =>
      key === v || label.toLowerCase() === v || (key === 'reverse_charge_13b' && v.includes('13b')),
  )
  return (found?.[0] as CreateContactRequest['taxMode']) ?? ('invalid' as never)
}

function countryOf(value: string): string {
  const v = value.trim()
  if (!v || /^deutschland$/i.test(v)) return 'DE'
  if (/^österreich$/i.test(v)) return 'AT'
  if (/^schweiz$/i.test(v)) return 'CH'
  return v.toUpperCase()
}

/** One CSV row → create request (validated afterwards with createContactRequest). */
function requestOf(get: (column: (typeof CONTACT_CSV_COLUMNS)[number]) => string) {
  const organizationName = get('Firma')
  const typ = get('Typ').toLowerCase()
  const named = Boolean(get('Vorname') || get('Nachname'))
  // Without Typ: Firma + Vor-/Nachname is a person of that company (the import asks whether to
  // create the organization and link the person as Ansprechpartner); Firma alone an organization.
  const kind = typ.startsWith('p')
    ? 'person'
    : typ.startsWith('o') || typ.startsWith('f')
      ? 'organization'
      : organizationName && !named
        ? 'organization'
        : 'person'
  const channels = [
    ...(get('E-Mail') ? [{ kind: 'email', value: get('E-Mail'), isPrimary: true }] : []),
    ...(get('Telefon') ? [{ kind: 'phone', value: get('Telefon'), isPrimary: true }] : []),
    ...(get('Mobil') ? [{ kind: 'mobile', value: get('Mobil'), isPrimary: !get('Telefon') }] : []),
  ]
  const hasAddress = ['Straße', 'Adresszusatz', 'PLZ', 'Ort'].some((c) => get(c as never))
  const empty = (v: string) => v || null
  return {
    kind,
    organizationName: kind === 'organization' ? empty(organizationName) : null,
    company: kind === 'person' ? empty(organizationName) : null,
    salutation: empty(get('Anrede')),
    title: empty(get('Titel')),
    firstName: empty(get('Vorname')),
    lastName: empty(get('Nachname')),
    website: empty(get('Website')),
    vatId: empty(get('USt-IdNr.')),
    taxMode: taxModeOf(get('Steuerfall')),
    buyerReference: empty(get('Leitweg-ID')),
    einvoiceEmail: empty(get('E-Mail für E-Rechnungen')),
    description: empty(get('Beschreibung')),
    channels,
    addresses: hasAddress
      ? [
          {
            kind: 'main',
            street: empty(get('Straße')),
            streetExtra: empty(get('Adresszusatz')),
            postalCode: empty(get('PLZ')),
            city: empty(get('Ort')),
            countryCode: countryOf(get('Land')),
          },
        ]
      : [],
  }
}

const displayNameOf = (r: {
  organizationName?: string | null
  firstName?: string | null
  lastName?: string | null
}) => r.organizationName || [r.lastName, r.firstName].filter(Boolean).join(', ')

const validEmail = (value: string) => !value || z.email().safeParse(value).success

async function importContacts(
  tx: Tx,
  auth: { tenantId: string; userId: string },
  input: {
    csv: string
    dryRun: boolean
    assignCustomerNumbers: boolean
    createOrganizations: boolean
  },
): Promise<ContactImportResult> {
  const [header, ...lines] = parseCsv(input.csv)
  if (!header) throw new HttpError(400, 'Die Datei ist leer.', { csv: 'Keine Zeilen gefunden.' })
  const columns = header.map((h) => ALIASES[normalize(h)] ?? null)
  if (!columns.some((c) => c === 'Firma' || c === 'Nachname' || c === 'Vorname')) {
    throw new HttpError(
      400,
      'Die Kopfzeile enthält weder „Firma“ noch „Vorname“/„Nachname“. Bitte die Vorlage aus dem Export verwenden.',
      { csv: 'Unbekannte Spalten.' },
    )
  }
  if (lines.length > MAX_ROWS) {
    throw new HttpError(400, `Höchstens ${MAX_ROWS} Kontakte je Import.`, {
      csv: 'Zu viele Zeilen.',
    })
  }
  const existing = await tx<{ number: string | null; key: string }[]>`
    select c.number, lower(c.display_name) || '|' || coalesce((select a.postal_code from contact_address a
           where a.contact_id = c.id and a.kind = 'main' limit 1), '') as key
    from contact c`
  const numbers = new Set(existing.map((e) => e.number).filter(Boolean))
  // Organizations by name (lower case) → id; filled with the ones created by this import.
  const organizations = new Map(
    (
      await tx<{ id: string; name: string }[]>`
        select id, lower(display_name) as name from contact where kind = 'organization'`
    ).map((o) => [o.name, o.id as string | null]),
  )
  const drawNumber = async (given: string | null) =>
    given || !input.assignCustomerNumbers
      ? given
      : ((await tx<{ n: string }[]>`select next_number('contact') as n`)[0]?.n ?? null)
  const keys = new Set(existing.map((e) => e.key))
  const rows: ContactImportRow[] = []
  for (const [index, line] of lines.entries()) {
    const get = (column: (typeof CONTACT_CSV_COLUMNS)[number]) =>
      (line[columns.indexOf(column)] ?? '').trim()
    const raw = requestOf(get)
    const name = displayNameOf(raw) || '–'
    const company = raw.company
    const known = company ? organizations.has(company.toLowerCase()) : false
    const row = (action: ContactImportRow['action'], message: string | null) =>
      rows.push({
        line: index + 2,
        name,
        action,
        message,
        organization: action === 'create' ? company : null,
        organizationAction: action === 'create' && company ? (known ? 'link' : 'create') : null,
      })
    if (!validEmail(get('E-Mail'))) {
      row('error', `Ungültige E-Mail-Adresse „${get('E-Mail')}“.`)
      continue
    }
    if (raw.taxMode === ('invalid' as never)) {
      row('error', `Unbekannter Steuerfall „${get('Steuerfall')}“.`)
      continue
    }
    const { company: _, ...fields } = raw
    const parsed = createContactRequest.safeParse({ ...fields, assignCustomerNumber: false })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      row('error', `${issue?.path.join('.') || 'Zeile'}: ${issue?.message ?? 'ungültig'}`)
      continue
    }
    const number = get('Kundennummer') || null
    if (number && numbers.has(number)) {
      row('skip', `Kundennummer ${number} gibt es schon.`)
      continue
    }
    const key = `${name.toLowerCase()}|${parsed.data.addresses?.[0]?.postalCode ?? ''}`
    if (keys.has(key)) {
      row('skip', 'Einen Kontakt mit diesem Namen und dieser PLZ gibt es schon.')
      continue
    }
    if (number) numbers.add(number)
    keys.add(key)
    if (!input.dryRun) {
      const contactId = await insertContact(tx, auth, parsed.data, await drawNumber(number))
      if (company && input.createOrganizations) {
        let organizationId = organizations.get(company.toLowerCase()) ?? null
        if (!organizationId) {
          // New organization with the address of the row; the person becomes its Ansprechpartner.
          organizationId = await insertContact(
            tx,
            auth,
            createContactRequest.parse({
              kind: 'organization',
              organizationName: company,
              addresses: parsed.data.addresses,
            }),
            await drawNumber(null),
          )
          organizations.set(company.toLowerCase(), organizationId)
        }
        await tx`insert into contact_link (tenant_id, person_id, organization_id)
                 values (${auth.tenantId}, ${contactId}, ${organizationId})
                 on conflict (person_id, organization_id) do nothing`
      }
    } else if (company && !known) {
      // Preview: the same company in later rows is linked, not created twice.
      organizations.set(company.toLowerCase(), null)
    }
    row('create', number ? `Kundennummer ${number}` : null)
  }
  return {
    dryRun: input.dryRun,
    created: rows.filter((r) => r.action === 'create').length,
    skipped: rows.filter((r) => r.action === 'skip').length,
    errors: rows.filter((r) => r.action === 'error').length,
    withOrganization: rows.filter((r) => r.organization).length,
    rows,
  }
}

export function registerContactCsvRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/contacts/export.csv', async (request, reply) => {
    const auth = requirePermission(request, 'contacts.read')
    const query = parse(contactListQuery, request.query)
    const rows = await inTenant(
      services,
      auth,
      (tx) => tx<Record<string, string | null>[]>`
        select c.kind, c.number, c.organization_name as org, c.salutation, c.title, c.first_name as first,
               c.last_name as last, a.street, a.street_extra as extra, a.postal_code as zip, a.city,
               a.country_code as country, c.website, c.vat_id as vat, c.tax_mode as tax,
               c.buyer_reference as leitweg, c.einvoice_email as einvoice, c.description,
               (select value from contact_channel ch where ch.contact_id = c.id and ch.kind = 'email'
                order by ch.is_primary desc, ch.id limit 1) as email,
               (select value from contact_channel ch where ch.contact_id = c.id and ch.kind = 'phone'
                order by ch.is_primary desc, ch.id limit 1) as phone,
               (select value from contact_channel ch where ch.contact_id = c.id and ch.kind = 'mobile'
                order by ch.is_primary desc, ch.id limit 1) as mobile
        from contact c
        left join lateral (select * from contact_address x where x.contact_id = c.id
                           order by (x.kind = 'main') desc limit 1) a on true
        where (c.archived_at is not null) = ${query.archived === 'true'}
          and (${query.kind ?? null}::text is null or c.kind = ${query.kind ?? null})
          and (${query.color ?? null}::text is null or c.color = ${query.color ?? null})
          and (${query.customer ?? null}::text is null or (c.number is not null) = ${query.customer === 'true'})
        order by lower(c.display_name), c.id`,
    )
    const body = csv(
      CONTACT_CSV_COLUMNS,
      rows.map((r) => [
        r.kind === 'organization' ? 'Organisation' : 'Person',
        r.number,
        r.org,
        r.salutation,
        r.title,
        r.first,
        r.last,
        r.street,
        r.extra,
        r.zip,
        r.city,
        r.country,
        r.email,
        r.phone,
        r.mobile,
        r.website,
        r.vat,
        TAX_LABELS[(r.tax ?? 'standard') as keyof typeof TAX_LABELS],
        r.leitweg,
        r.einvoice,
        r.description,
      ]),
    )
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="Kontakte_${todayIn(services.now())}.csv"`,
      )
      .send(`﻿${body}`)
  })

  app.post('/api/v1/contacts/import', async (request): Promise<ContactImportResult> => {
    const auth = requirePermission(request, 'contacts.write')
    const input = parse(importContactsRequest, request.body)
    return inTenant(services, auth, (tx) => importContacts(tx, auth, input))
  })
}
