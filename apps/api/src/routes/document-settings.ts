import { Readable } from 'node:stream'
import type { Tx } from '@easybau/db'
import {
  checkFileNamePattern,
  companyNotices,
  DEFAULT_FILE_NAME_PATTERN,
  FILE_NAME_PLACEHOLDERS,
  type FileNamePlaceholder,
  fileNameFrom,
  isFederalState,
  type Letterhead,
  type LetterheadValues,
  letterheadGaps,
  publicHolidays,
} from '@easybau/domain'
import { documentTitle } from '@easybau/pdf-templates'
import {
  type AttachmentFile,
  attachmentUploadQuery,
  type CompanyNoticeEntry,
  type DocumentDetail,
  type DocumentSettings,
  type DocumentSettingsRequest,
  documentSettingsRequest,
  type HolidayList,
  holidayQuery,
  holidayRequest,
  settingsIdParam,
} from '@easybau/schemas'
import { TooLargeError } from '@easybau/storage'
import type { FastifyInstance } from 'fastify'
import { inTenant, requireAuth, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { liveIssuer } from './letterhead.js'
import { todayOf } from './receivable-state.js'

/**
 * Einstellungen ergänzen (P2.11): Dokument-Vorgaben (Lohnkostenanteil § 35a, Abschlagsart,
 * Dateinamen-Muster, automatische Anhänge), gesetzliche Feiertage nach Bundesland plus eigene,
 * and the Hinweisleiste for missing company data.
 */

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettingsRequest = {
  // DESIGN.md §7.4: Standard „Rechnungen an Personen“.
  laborShare: {
    invoice: { person: true, organization: false },
    offer: { person: false, organization: false },
  },
  progressBillingMode: 'cumulative',
  fileNamePattern: DEFAULT_FILE_NAME_PATTERN,
  attachments: {},
  retiredAttachments: [],
}

const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

export async function documentSettings(tx: Tx): Promise<DocumentSettingsRequest> {
  const [row] = await tx<{ documents: Partial<DocumentSettingsRequest> | null }[]>`
    select settings -> 'documents' as documents from tenant where id = current_tenant_id()`
  return { ...DEFAULT_DOCUMENT_SETTINGS, ...(row?.documents ?? {}) }
}

/** Default of „Lohnkostenanteil ausweisen“ for a new document (matrix in the settings). */
export function laborShareDefault(
  settings: Pick<DocumentSettingsRequest, 'laborShare'>,
  type: string,
  contactKind: string | null,
): boolean {
  if (!contactKind) return false
  const kind = contactKind === 'person' ? 'person' : 'organization'
  if (type === 'invoice' || type === 'credit_note') return settings.laborShare.invoice[kind]
  if (['quote', 'cost_estimate', 'order_confirmation', 'change_order'].includes(type)) {
    return settings.laborShare.offer[kind]
  }
  return false
}

type NamedDocument = Pick<
  DocumentDetail,
  'type' | 'invoiceKind' | 'progressNo' | 'changeOrder' | 'number' | 'documentDate'
> & {
  project: { name: string }
  recipient: { name: string } | null
  contact: { displayName: string } | null
}

export function fileNameValues(doc: NamedDocument): Record<FileNamePlaceholder, string | null> {
  return {
    // "2. Abschlagsrechnung" → "2_Abschlagsrechnung"
    Typ: documentTitle(doc).replace(/\./g, ''),
    Nummer: doc.number ?? 'Entwurf',
    Kunde: doc.recipient?.name ?? doc.contact?.displayName ?? null,
    Projekt: doc.project.name,
    Datum: doc.documentDate,
    Jahr: doc.documentDate.slice(0, 4),
  }
}

/** File name of a document PDF after the company's Dateinamen-Muster. */
export async function documentFileName(
  tx: Tx,
  doc: NamedDocument,
  extension = 'pdf',
): Promise<string> {
  const { fileNamePattern } = await documentSettings(tx)
  return fileNameFrom(fileNamePattern, fileNameValues(doc), extension)
}

/**
 * File name after the company's pattern for other files (Mahnung, Aufmaßblatt, Bericht, XRechnung):
 * the same placeholders, filled from the file's own values; `suffix` is appended to the name.
 */
export async function patternFileName(
  tx: Tx,
  values: Partial<Record<FileNamePlaceholder, string | null>>,
  extension = 'pdf',
  suffix?: string,
): Promise<string> {
  const { fileNamePattern } = await documentSettings(tx)
  const name = fileNameFrom(fileNamePattern, values, extension)
  return suffix ? `${name.slice(0, -(extension.length + 1))}_${suffix}.${extension}` : name
}

/** File name of a document's XRechnung/ZUGFeRD XML: PDF name plus the format. */
export async function documentXmlFileName(
  tx: Tx,
  doc: NamedDocument,
  suffix: string,
): Promise<string> {
  return patternFileName(tx, fileNameValues(doc), 'xml', suffix)
}

/** Holidays of the company (statutory of its Bundesland + own) for the given years, as ISO dates. */
export async function holidayDates(tx: Tx, years: number[]): Promise<Set<string>> {
  const [tenant] = await tx<{ state: string | null }[]>`
    select federal_state as state from tenant where id = current_tenant_id()`
  const state = isFederalState(tenant?.state) ? tenant.state : null
  const dates = new Set<string>()
  for (const year of years) {
    if (state && year >= 1995 && year <= 2199)
      for (const h of publicHolidays(year, state)) dates.add(h.date)
  }
  const own = await tx<{ date: string }[]>`
    select to_char(day, 'YYYY-MM-DD') as date from holiday
    where extract(year from day)::int in ${tx(years)}`
  for (const h of own) dates.add(h.date)
  return dates
}

export async function attachmentFiles(tx: Tx): Promise<AttachmentFile[]> {
  const retired = new Set((await documentSettings(tx)).retiredAttachments)
  const rows = await tx<Omit<AttachmentFile, 'retired'>[]>`
    select id, name, size_bytes::float8 as "sizeBytes",
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from tenant_asset where kind = 'attachment' order by created_at desc`
  return rows.map((row) => ({ ...row, retired: retired.has(row.id) }))
}

/** Automatic attachments of a document type (or of Mahnungen) that are still offered. */
export async function automaticAttachments(
  tx: Tx,
  type: keyof DocumentSettingsRequest['attachments'],
): Promise<string[]> {
  const settings = await documentSettings(tx)
  const retired = new Set(settings.retiredAttachments)
  return (settings.attachments[type] ?? []).filter((id) => !retired.has(id))
}

async function loadSettings(tx: Tx): Promise<DocumentSettings> {
  const stored = await documentSettings(tx)
  return {
    ...stored,
    placeholders: [...FILE_NAME_PLACEHOLDERS],
    defaultFileNamePattern: DEFAULT_FILE_NAME_PATTERN,
    files: await attachmentFiles(tx),
    example: fileNameFrom(
      stored.fileNamePattern,
      {
        Typ: 'Rechnung',
        Nummer: 'R2026-00101',
        Kunde: 'Mustermann, Max',
        Projekt: 'Badsanierung',
        Datum: '2026-11-13',
        Jahr: '2026',
      },
      'pdf',
    ),
  }
}

const invalid = (errors: Record<string, string>) =>
  new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)

export function registerDocumentSettingsRoutes(app: FastifyInstance, services: Services) {
  // ---- Dokument-Vorgaben ----

  app.get('/api/v1/settings/documents', async (request) => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, loadSettings)
  })

  app.put('/api/v1/settings/documents', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(documentSettingsRequest, request.body)
    const patternError = checkFileNamePattern(input.fileNamePattern)
    if (patternError) throw invalid({ fileNamePattern: patternError })
    return inTenant(services, auth, async (tx) => {
      const ids = [
        ...new Set([...Object.values(input.attachments).flat(), ...input.retiredAttachments]),
      ] as string[]
      if (ids.length) {
        const found = await tx<{ id: string }[]>`
          select id from tenant_asset where kind = 'attachment' and id in ${tx(ids)}`
        if (found.length !== ids.length) {
          throw invalid({ attachments: 'Ein Anhang wurde nicht gefunden. Bitte erneut hochladen.' })
        }
      }
      const attachments = Object.fromEntries(
        Object.entries(input.attachments).filter(([, list]) => list?.length),
      )
      const stored = {
        ...input,
        attachments,
        retiredAttachments: [...new Set(input.retiredAttachments)],
      }
      await tx`update tenant set settings = jsonb_set(settings, '{documents}', ${tx.json(stored as never)})
               where id = current_tenant_id()`
      return loadSettings(tx)
    })
  })

  // Anhang hochladen (PDF, höchstens 10 MB): raw bytes, file name in ?name=.
  app.post('/api/v1/settings/attachments', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const body = request.body
    if (!(body instanceof Readable)) {
      throw new HttpError(415, 'Bitte die Datei als application/octet-stream senden.')
    }
    const tooLarge = () => new HttpError(413, 'Der Anhang ist zu groß (höchstens 10 MB).')
    let query: { name: string }
    try {
      query = parse(attachmentUploadQuery, request.query)
    } catch (error) {
      body.resume()
      throw error
    }
    if (Number(request.headers['content-length'] ?? 0) > ATTACHMENT_MAX_BYTES) {
      body.resume()
      throw tooLarge()
    }
    let pending: Awaited<ReturnType<typeof services.storage.receive>>
    try {
      pending = await services.storage.receive(body, { maxBytes: ATTACHMENT_MAX_BYTES })
    } catch (error) {
      body.resume()
      if (error instanceof TooLargeError) throw tooLarge()
      throw error
    }
    try {
      if (pending.head.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new HttpError(415, 'Als Anhang sind nur PDF-Dateien erlaubt.')
      }
      const upload = pending
      const name = query.name.toLowerCase().endsWith('.pdf') ? query.name : `${query.name}.pdf`
      const file = await inTenant(services, auth, async (tx) => {
        const [existing] = await tx<{ id: string; kind: string }[]>`
          select id, kind from tenant_asset where sha256 = ${upload.sha256}`
        if (existing && existing.kind !== 'attachment') {
          throw new HttpError(409, 'Diese Datei kann nicht als Anhang verwendet werden.')
        }
        let id = existing?.id
        if (!id) {
          const [ids] = await tx<{ id: string }[]>`select uuid_v7() as id`
          id = (ids as { id: string }).id
          const key = `${auth.tenantId}/assets/${id}`
          await tx`
            insert into tenant_asset (id, tenant_id, kind, name, storage_key, sha256, mime_type, size_bytes, created_by)
            values (${id}, ${auth.tenantId}, 'attachment', ${name}, ${key}, ${upload.sha256},
                    'application/pdf', ${upload.sizeBytes}, ${auth.userId})`
          await upload.commit(key)
        }
        return (await attachmentFiles(tx)).find((f) => f.id === id) as AttachmentFile
      })
      return reply.status(201).send(file)
    } finally {
      await pending.discard()
    }
  })

  // ---- Feiertage ----

  const holidayList = async (tx: Tx, year: number): Promise<HolidayList> => {
    const [tenant] = await tx<{ state: string | null }[]>`
      select federal_state as state from tenant where id = current_tenant_id()`
    const state = isFederalState(tenant?.state) ? tenant.state : null
    const own = await tx<{ id: string; date: string; name: string }[]>`
      select id, to_char(day, 'YYYY-MM-DD') as date, name from holiday
      where day between make_date(${year}, 1, 1) and make_date(${year}, 12, 31)`
    const statutory = state ? publicHolidays(year, state) : []
    return {
      year,
      federalState: state,
      holidays: [
        ...statutory.map((h) => ({ id: null, date: h.date, name: h.name, custom: false })),
        ...own.map((h) => ({ ...h, custom: true })),
      ].sort((a, b) => a.date.localeCompare(b.date) || Number(a.custom) - Number(b.custom)),
    }
  }

  app.get('/api/v1/settings/holidays', async (request): Promise<HolidayList> => {
    const auth = requireAuth(request)
    const { year } = parse(holidayQuery, request.query)
    return inTenant(services, auth, (tx) => holidayList(tx, year))
  })

  app.post('/api/v1/settings/holidays', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(holidayRequest, request.body)
    const year = Number(input.date.slice(0, 4))
    if (year < 1995 || year > 2199) throw invalid({ date: 'Jahr zwischen 1995 und 2199.' })
    const list = await inTenant(services, auth, async (tx) => {
      await tx`
        insert into holiday (tenant_id, day, name, is_custom)
        values (${auth.tenantId}, ${input.date}, ${input.name}, true)`.catch(
        (error: { code?: string }) => {
          if (error.code === '23505') {
            throw invalid({ date: 'Für diesen Tag gibt es schon einen eigenen Eintrag.' })
          }
          throw error
        },
      )
      return holidayList(tx, year)
    })
    return reply.status(201).send(list)
  })

  // Own holidays are no tax-relevant data; removing one is allowed.
  app.delete('/api/v1/settings/holidays/:id', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const { id } = parse(settingsIdParam, request.params)
    await inTenant(services, auth, async (tx) => {
      const deleted = await tx`delete from holiday where id = ${id}`
      if (!deleted.count) throw notFound('Der Feiertag')
    })
    return reply.status(204).send()
  })

  // ---- Hinweisleiste ----

  app.get('/api/v1/notices', async (request): Promise<CompanyNoticeEntry[]> => {
    const auth = requireAuth(request)
    return inTenant(services, auth, async (tx) => {
      const [company] = await tx<
        {
          name: string
          street: string | null
          postalCode: string | null
          city: string | null
          taxNumber: string | null
          vatId: string | null
          hasIban: boolean
          email: string | null
          federalState: string | null
        }[]
      >`
        select name, street, postal_code as "postalCode", city, tax_number as "taxNumber", vat_id as "vatId",
               iban_enc is not null as "hasIban", email, federal_state as "federalState"
        from tenant where id = current_tenant_id()`
      const [user] = await tx<{ verified: boolean }[]>`
        select email_verified_at is not null as verified from app_user where id = ${auth.userId}`
      if (!company) return []
      const { hasIban, ...rest } = company
      // Rechnungseingang: only for people who may fix the settings and while it is fetched.
      const [mail] =
        services.config.INCOMING_MAIL_ENABLED && auth.permissions.has('settings.write')
          ? await tx<
              {
                mailbox: {
                  enabled?: boolean
                  auth?: string
                  clientSecretExpiresOn?: string
                  lastRun?: { error: string | null; failedRuns?: number }
                } | null
              }[]
            >`select settings -> 'incomingMail' as mailbox from tenant where id = current_tenant_id()`
          : []
      const mailbox = mail?.mailbox?.enabled ? mail.mailbox : null
      // Briefpapier: Pflichtangaben that the letterhead would not print (people who may edit it).
      const issuer = auth.permissions.has('tenant.manage') ? await liveIssuer(tx) : null
      const gaps =
        issuer?.letterhead && issuer.values
          ? letterheadGaps(issuer.letterhead as Letterhead, issuer.values as LetterheadValues)
          : []
      const [admins] = auth.permissions.has('users.manage')
        ? await tx<{ n: number }[]>`
            select count(*)::int as n from membership m
            join role r on r.id = m.role_id join app_user u on u.id = m.user_id
            where r.key = 'admin' and u.is_active and u.totp_enabled_at is null
              and not exists (select 1 from webauthn_credential w where w.user_id = u.id)`
        : []
      return companyNotices({
        letterheadGaps: gaps,
        adminsWithoutSecondFactor: admins?.n ?? 0,
        company: { ...rest, iban: hasIban ? 'set' : null },
        canManageCompany: auth.permissions.has('tenant.manage'),
        emailVerified: services.config.SMTP_ENABLED ? (user?.verified ?? false) : null,
        ...(mailbox
          ? {
              incomingMail: {
                failedRuns: mailbox.lastRun?.error ? (mailbox.lastRun.failedRuns ?? 1) : 0,
                lastError: mailbox.lastRun?.error ?? null,
                secretExpiresOn:
                  mailbox.auth === 'microsoft365' ? (mailbox.clientSecretExpiresOn ?? null) : null,
                today: todayOf(tx),
              },
            }
          : {}),
      })
    })
  })
}
