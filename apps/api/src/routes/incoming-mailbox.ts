import { createPrivateKey, createSign } from 'node:crypto'
import type { Tx } from '@easybau/db'
import {
  type IncomingMailAuth,
  type IncomingMailLogAttachment,
  type IncomingMailLogEntry,
  type IncomingMailLogPage,
  type IncomingMailRun,
  type IncomingMailSettings,
  incomingMailLogQuery,
  incomingMailSettingsRequest,
} from '@easybau/schemas'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { inTenant, requirePermission, type Services } from '../context.js'
import { decodeCursor, encodeCursor, HttpError, parse } from '../http.js'
import { ingestIncomingInvoice } from './incoming-invoices.js'

/**
 * Rechnungseingang per E-Mail (P2.4): each company may enter an IMAP mailbox (e.g.
 * rechnungen@firma.de). The app fetches unread messages, takes every attachment that is an
 * invoice (PDF, ZUGFeRD, XRechnung XML, JPG/PNG) into „Zu prüfen“ exactly like an upload and
 * marks the message as read (or moves it to a folder). Off unless the operator sets
 * INCOMING_MAIL_ENABLED=true; the password is stored encrypted (APP_SECRET).
 *
 * Microsoft 365 no longer accepts IMAP with a password: there the company registers an app in
 * Microsoft Entra (IMAP.AccessAsApp, mailbox released for the app) and enters Verzeichnis-ID,
 * Anwendungs-ID and client secret. The app gets a token per run (client credentials at
 * login.microsoftonline.com) and logs in with IMAP XOAUTH2. Only then does it contact Microsoft.
 */

export interface MailAttachment {
  filename: string
  content: Buffer
  /** Embedded in the text (e.g. logo of an e-mail signature), not a real attachment. */
  inline?: boolean
}

export interface MailMessage {
  uid: number
  from: string | null
  subject: string | null
  attachments: MailAttachment[]
  /** Larger than allowed: not downloaded (no attachments), only logged and marked as done. */
  tooLarge?: boolean
}

export interface MailboxConnection {
  /**
   * Unread messages, oldest first, at most `limit`. Messages above `maxBytes` are not downloaded
   * (`tooLarge`); the batch stops early once twice that size has been read, the rest comes next run.
   */
  unread(limit: number, maxBytes?: number): Promise<MailMessage[]>
  /** Processed: mark as read or move to the processed folder. */
  done(uid: number): Promise<void>
  close(): Promise<void>
}

export interface MicrosoftOAuth {
  tenantId: string
  clientId: string
  clientSecret: string
}

export interface MailboxAccess {
  host: string
  port: number
  secure: boolean
  user: string
  /** IMAP LOGIN; null with Microsoft 365 or Google (OAuth2). */
  password: string | null
  oauth: MicrosoftOAuth | null
  google: GoogleServiceAccount | null
  mailbox: string
  processedMailbox: string | null
}

export type MailboxConnector = (access: MailboxAccess) => Promise<MailboxConnection>

/** Google Workspace: service account with domain-wide delegation for https://mail.google.com/. */
export interface GoogleServiceAccount {
  clientEmail: string
  privateKey: string
}

const MESSAGES_PER_RUN = 25
const INVOICE_EXTENSIONS = /\.(pdf|xml|jpe?g|png)$/i
const M365_IMAP_HOST = 'outlook.office365.com'
const GOOGLE_IMAP_HOST = 'imap.gmail.com'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Thrown when Google refuses the service account (key, delegation or scope). */
export class GoogleTokenError extends Error {
  constructor(readonly status: number) {
    super(`Google token request failed (${status})`)
  }
}

/**
 * Reads the JSON key of a Google service account (as downloaded from the Cloud console). Only
 * client_email and private_key are kept; throws a German message for the settings form.
 */
export function parseGoogleServiceAccountKey(json: string): GoogleServiceAccount {
  let key: { type?: unknown; client_email?: unknown; private_key?: unknown }
  try {
    key = JSON.parse(json)
  } catch {
    throw new HttpError(400, 'Die Schlüsseldatei ist keine gültige JSON-Datei.', {
      googleServiceAccountKey: 'Bitte die JSON-Schlüsseldatei des Dienstkontos hochladen.',
    })
  }
  const clientEmail = typeof key.client_email === 'string' ? key.client_email : ''
  const privateKey = typeof key.private_key === 'string' ? key.private_key : ''
  let valid = key.type === 'service_account' && /^[^@\s]+@[^@\s]+$/.test(clientEmail)
  if (valid) {
    try {
      valid = createPrivateKey(privateKey).asymmetricKeyType === 'rsa'
    } catch {
      valid = false
    }
  }
  if (!valid) {
    throw new HttpError(400, 'Die Schlüsseldatei gehört zu keinem Google-Dienstkonto.', {
      googleServiceAccountKey: 'Bitte die JSON-Schlüsseldatei des Dienstkontos hochladen.',
    })
  }
  return { clientEmail, privateKey }
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

/**
 * Access token for Gmail IMAP of a Google Workspace mailbox: the service account signs a JWT
 * for the mailbox user (domain-wide delegation, RFC 7523). The key only signs locally; the token
 * is not stored.
 */
export async function googleImapToken(
  account: GoogleServiceAccount,
  user: string,
  now: number,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const iat = Math.floor(now / 1000)
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({
      iss: account.clientEmail,
      sub: user,
      scope: 'https://mail.google.com/',
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  )}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.privateKey)
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64url(signature)}`,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null
  if (!res.ok || typeof body?.access_token !== 'string') throw new GoogleTokenError(res.status)
  return body.access_token
}

/** Thrown when Microsoft refuses the client credentials (wrong IDs or secret). */
export class MicrosoftTokenError extends Error {
  constructor(readonly status: number) {
    super(`Microsoft token request failed (${status})`)
  }
}

/**
 * Access token for IMAP of Exchange Online (OAuth2 client credentials, RFC 6749 § 4.4). The
 * secret only goes to Microsoft; the token is not stored.
 */
export async function microsoftImapToken(
  oauth: MicrosoftOAuth,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(
    `https://login.microsoftonline.com/${encodeURIComponent(oauth.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        scope: 'https://outlook.office365.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    },
  )
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null
  if (!res.ok || typeof body?.access_token !== 'string') throw new MicrosoftTokenError(res.status)
  return body.access_token
}

/** IMAP with imapflow; messages are parsed with mailparser (attachments only, no HTML). */
export const imapConnector: MailboxConnector = async (access) => {
  const auth = access.oauth
    ? { user: access.user, accessToken: await microsoftImapToken(access.oauth) }
    : access.google
      ? {
          user: access.user,
          accessToken: await googleImapToken(access.google, access.user, Date.now()),
        }
      : { user: access.user, pass: access.password ?? '' }
  const client = new ImapFlow({
    host: access.host,
    port: access.port,
    secure: access.secure,
    auth,
    logger: false,
    socketTimeout: 60_000,
  })
  await client.connect()
  const lock = await client.getMailboxLock(access.mailbox)
  return {
    async unread(limit, maxBytes = Number.POSITIVE_INFINITY) {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []).slice(0, limit)
      const messages: MailMessage[] = []
      let read = 0
      for (const uid of uids) {
        // Size first: a sender must not make the server download and parse any amount of data.
        const head = await client.fetchOne(String(uid), { size: true }, { uid: true })
        if (head === false) continue
        if ((head.size ?? 0) > maxBytes) {
          messages.push({ uid, from: null, subject: null, attachments: [], tooLarge: true })
          continue
        }
        if (messages.length > 0 && read + (head.size ?? 0) > 2 * maxBytes) break
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true })
        if (message === false || !message.source) continue
        read += message.source.length
        const parsed = await simpleParser(message.source)
        messages.push({
          uid,
          from: parsed.from?.text ?? null,
          subject: parsed.subject ?? null,
          attachments: parsed.attachments.map((a) => ({
            filename: a.filename ?? 'anhang',
            content: a.content,
            inline: a.related || a.contentDisposition === 'inline',
          })),
        })
      }
      return messages
    },
    async done(uid) {
      if (access.processedMailbox) {
        await client.messageMove(String(uid), access.processedMailbox, { uid: true })
      } else {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
      }
    },
    async close() {
      lock.release()
      await client.logout().catch(() => client.close())
    },
  }
}

interface StoredMailbox {
  enabled?: boolean
  auth?: IncomingMailAuth
  tenantId?: string
  clientId?: string
  clientSecretEnc?: string
  clientSecretExpiresOn?: string
  googleKeyEnc?: string
  googleClientEmail?: string
  host?: string
  port?: number
  secure?: boolean
  user?: string
  passwordEnc?: string
  mailbox?: string
  processedMailbox?: string | null
  lastRun?: IncomingMailRun
}

async function storedMailbox(tx: Tx): Promise<StoredMailbox> {
  const [row] = await tx<{ mailbox: StoredMailbox | null }[]>`
    select settings -> 'incomingMail' as mailbox from tenant where id = current_tenant_id()`
  return row?.mailbox ?? {}
}

function view(services: Services, stored: StoredMailbox): IncomingMailSettings {
  return {
    available: services.config.INCOMING_MAIL_ENABLED ?? false,
    enabled: stored.enabled ?? false,
    auth: stored.auth ?? 'password',
    host: stored.host ?? null,
    port: stored.port ?? 993,
    secure: stored.secure ?? true,
    user: stored.user ?? null,
    hasPassword: Boolean(stored.passwordEnc),
    tenantId: stored.tenantId ?? null,
    clientId: stored.clientId ?? null,
    hasClientSecret: Boolean(stored.clientSecretEnc),
    clientSecretExpiresOn: stored.clientSecretExpiresOn ?? null,
    googleClientEmail: stored.googleKeyEnc ? (stored.googleClientEmail ?? null) : null,
    mailbox: stored.mailbox ?? 'INBOX',
    processedMailbox: stored.processedMailbox ?? null,
    lastRun: stored.lastRun ?? null,
  }
}

const decrypt = (services: Services, value: string) =>
  services.cipher.decrypt(Buffer.from(value, 'base64'))

function accessOf(services: Services, stored: StoredMailbox): MailboxAccess | null {
  if (!stored.user) return null
  const common = {
    port: stored.port ?? 993,
    secure: stored.secure ?? true,
    user: stored.user,
    mailbox: stored.mailbox ?? 'INBOX',
    processedMailbox: stored.processedMailbox ?? null,
  }
  if (stored.auth === 'microsoft365') {
    if (!stored.tenantId || !stored.clientId || !stored.clientSecretEnc) return null
    return {
      ...common,
      host: stored.host ?? M365_IMAP_HOST,
      password: null,
      google: null,
      oauth: {
        tenantId: stored.tenantId,
        clientId: stored.clientId,
        clientSecret: decrypt(services, stored.clientSecretEnc),
      },
    }
  }
  if (stored.auth === 'google') {
    if (!stored.googleKeyEnc) return null
    const key = JSON.parse(decrypt(services, stored.googleKeyEnc)) as GoogleServiceAccount
    return {
      ...common,
      host: stored.host ?? GOOGLE_IMAP_HOST,
      password: null,
      oauth: null,
      google: key,
    }
  }
  if (!stored.host || !stored.passwordEnc) return null
  return {
    ...common,
    host: stored.host,
    password: decrypt(services, stored.passwordEnc),
    oauth: null,
    google: null,
  }
}

/** Short reason without addresses or content (rule 9: no PII in logs or stored errors). */
function reasonOf(error: unknown, access: MailboxAccess): string {
  if (error instanceof HttpError) return error.message
  if (error instanceof GoogleTokenError) {
    return 'Anmeldung bei Google fehlgeschlagen (Dienstkonto, domainweite Delegierung mit dem Bereich https://mail.google.com/ und Postfach-Adresse prüfen).'
  }
  if (error instanceof MicrosoftTokenError) {
    return 'Anmeldung bei Microsoft 365 fehlgeschlagen (Verzeichnis-ID, Anwendungs-ID oder geheimer Clientschlüssel prüfen).'
  }
  const e = error as { authenticationFailed?: boolean; code?: string; name?: string }
  if (e.authenticationFailed) {
    if (access.oauth) {
      return 'Microsoft 365 hat die Anmeldung am Postfach abgelehnt (IMAP-Berechtigung der App und Freigabe des Postfachs für die App prüfen).'
    }
    if (access.google) {
      return 'Google hat die Anmeldung am Postfach abgelehnt (IMAP im Gmail-Admin erlauben, Postfach-Adresse prüfen).'
    }
    return 'Anmeldung am Postfach fehlgeschlagen (Benutzer oder Passwort).'
  }
  if (e.name === 'TimeoutError') return 'Der Anmeldedienst hat nicht rechtzeitig geantwortet.'
  if (e.code === 'ENOTFOUND') return 'Der Mailserver wurde nicht gefunden.'
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT')
    return 'Der Mailserver ist nicht erreichbar.'
  return 'Das Postfach konnte nicht abgerufen werden.'
}

/** Protokoll je E-Mail: one row per fetched message (deleted after 90 days by the worker). */
async function logMail(
  services: Services,
  system: { tenantId: string; userId: null },
  message: MailMessage,
  outcome: 'done' | 'retry',
  attachments: IncomingMailLogAttachment[],
) {
  await inTenant(services, system, async (tx) => {
    await tx`
      insert into incoming_mail_log (tenant_id, fetched_at, mail_from, subject, outcome, attachments)
      values (current_tenant_id(), ${new Date(services.now())}, ${message.from?.slice(0, 500) ?? null},
              ${message.subject?.slice(0, 500) ?? null}, ${outcome}, ${tx.json(attachments as never)})`
  })
}

/** Fetches one company's mailbox once. The result is stored as `lastRun`. */
export async function pollMailbox(
  services: Services,
  tenantId: string,
  connector: MailboxConnector,
): Promise<IncomingMailRun> {
  const system = { tenantId, userId: null }
  const stored = await inTenant(services, system, storedMailbox)
  const access = accessOf(services, stored)
  const run: IncomingMailRun = {
    at: new Date(services.now()).toISOString(),
    messages: 0,
    imported: 0,
    duplicates: 0,
    ignored: 0,
    failed: 0,
    error: null,
    failedRuns: 0,
  }
  if (!access) {
    run.error = 'Das Postfach ist nicht vollständig eingerichtet.'
  } else {
    let connection: MailboxConnection | null = null
    try {
      connection = await connector(access)
      // The same limit as for uploads; a whole e-mail may be larger (base64, text, signature).
      const maxFileBytes = services.config.UPLOAD_MAX_MB * 1024 * 1024
      for (const message of await connection.unread(MESSAGES_PER_RUN, 2 * maxFileBytes)) {
        run.messages += 1
        let retry = false
        const results: IncomingMailLogAttachment[] = []
        if (message.tooLarge) {
          run.ignored += 1
          results.push({ filename: '(E-Mail)', result: 'ignored', reason: 'E-Mail zu groß' })
        }
        for (const attachment of message.attachments) {
          const filename = attachment.filename.slice(0, 255)
          if (attachment.content.length > maxFileBytes) {
            run.ignored += 1
            results.push({ filename, result: 'ignored', reason: 'Datei zu groß' })
            continue
          }
          // Pictures embedded in the text (signature logos) are no invoices; PDFs/XML always count.
          const embeddedPicture = attachment.inline && !/\.(pdf|xml)$/i.test(attachment.filename)
          if (!INVOICE_EXTENSIONS.test(attachment.filename) || embeddedPicture) {
            run.ignored += 1
            results.push({
              filename,
              result: 'ignored',
              reason: embeddedPicture ? 'Bild im E-Mail-Text' : 'kein Rechnungsformat',
            })
            continue
          }
          try {
            const incomingInvoiceId = await ingestIncomingInvoice(
              services,
              system,
              { filename: attachment.filename, data: attachment.content },
              { via: 'email', from: message.from, subject: message.subject },
            )
            run.imported += 1
            results.push({ filename, result: 'imported', incomingInvoiceId })
          } catch (error) {
            const status = error instanceof HttpError ? error.statusCode : 500
            const reason = error instanceof HttpError ? error.message : null
            if (status === 409) {
              run.duplicates += 1
              const existing = error instanceof HttpError ? error.errors?.existingId : undefined
              results.push({
                filename,
                result: 'duplicate',
                ...(existing ? { incomingInvoiceId: existing } : {}),
              })
            } else if (status >= 400 && status < 500) {
              // The file itself is unusable (wrong type, too large, unreadable e-invoice): retrying
              // cannot help, and 25 such e-mails would otherwise block the mailbox for good.
              run.ignored += 1
              results.push({ filename, result: 'ignored', reason })
            } else {
              // Temporary (database, storage): the message stays unread and is tried again.
              run.failed += 1
              retry = true
              results.push({ filename, result: 'failed', reason: 'vorübergehender Fehler' })
            }
          }
        }
        if (!retry) await connection.done(message.uid)
        await logMail(services, system, message, retry ? 'retry' : 'done', results)
      }
    } catch (error) {
      run.error = reasonOf(error, access)
    } finally {
      await connection?.close().catch(() => undefined)
    }
  }
  // Failed runs in a row, for the reminder in the Hinweisleiste.
  if (run.error) run.failedRuns = stored.lastRun?.error ? (stored.lastRun.failedRuns ?? 1) + 1 : 1
  await inTenant(services, system, async (tx) => {
    await tx`update tenant set settings = jsonb_set(settings, '{incomingMail,lastRun}', ${tx.json(run as never)})
             where id = current_tenant_id() and settings ? 'incomingMail'`
  })
  return run
}

/** All companies with an enabled mailbox, one after the other; one instance at a time. */
export async function pollIncomingMailboxes(
  services: Services,
  connector: MailboxConnector,
  logger?: Pick<FastifyBaseLogger, 'warn'>,
): Promise<number> {
  if (!services.config.INCOMING_MAIL_ENABLED) return 0
  const reserved = await services.sql.reserve()
  try {
    // Several API instances: only one fetches (session lock, released below).
    const [lock] = await reserved<
      { ok: boolean }[]
    >`select pg_try_advisory_lock(hashtext('easybau.incoming_mail')) as ok`
    if (!lock?.ok) return 0
    try {
      const tenants = await reserved<{ tenantId: string }[]>`
        select tenant_id as "tenantId" from incoming_mailbox_tenants()`
      let imported = 0
      for (const { tenantId } of tenants) {
        const run = await pollMailbox(services, tenantId, connector)
        imported += run.imported
        if (run.error) logger?.warn({ tenantId, reason: run.error }, 'incoming mailbox failed')
      }
      return imported
    } finally {
      await reserved`select pg_advisory_unlock(hashtext('easybau.incoming_mail'))`
    }
  } finally {
    reserved.release()
  }
}

export function registerIncomingMailboxRoutes(
  app: FastifyInstance,
  services: Services,
  options: { connector?: MailboxConnector; intervalMinutes?: number; poll?: boolean } = {},
) {
  const connector = options.connector ?? imapConnector

  app.get('/api/v1/settings/incoming-mail', async (request): Promise<IncomingMailSettings> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, async (tx) => view(services, await storedMailbox(tx)))
  })

  app.get('/api/v1/settings/incoming-mail/log', async (request): Promise<IncomingMailLogPage> => {
    const auth = requirePermission(request, 'settings.read')
    const { cursor, limit } = parse(incomingMailLogQuery, request.query)
    const after = decodeCursor(cursor, 2) as [string, string] | null
    return inTenant(services, auth, async (tx) => {
      const rows = await tx<(IncomingMailLogEntry & { sortAt: string })[]>`
        select id, to_char(fetched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "fetchedAt",
               fetched_at::text as "sortAt", mail_from as "from", subject, outcome, attachments
        from incoming_mail_log
        ${after ? tx`where (fetched_at, id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : tx``}
        order by fetched_at desc, id desc
        limit ${limit + 1}`
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        items: page.map(({ sortAt: _sortAt, ...entry }) => entry),
        nextCursor: rows.length > limit && last ? encodeCursor([last.sortAt, last.id]) : null,
      }
    })
  })

  app.put('/api/v1/settings/incoming-mail', async (request): Promise<IncomingMailSettings> => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(incomingMailSettingsRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const current = await storedMailbox(tx)
      // A stored secret is only ever sent to the destination and identity it was entered for:
      // changing server, port, TLS, sign-in method or account drops it, so it must be entered
      // again (security audit run-1: otherwise settings.write could redirect it to any host).
      const same = (a: string | undefined | null, b: string | undefined | null) =>
        (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
      const destinationChanged =
        (current.auth ?? 'password') !== input.auth ||
        !same(current.host, input.host) ||
        (current.port ?? 993) !== input.port ||
        (current.secure ?? true) !== input.secure ||
        !same(current.user, input.user) ||
        !same(current.tenantId, input.tenantId) ||
        !same(current.clientId, input.clientId)
      // undefined keeps the stored secret, '' or null removes it.
      const secret = (value: string | null | undefined, stored: string | undefined) =>
        value === undefined
          ? destinationChanged
            ? undefined
            : stored
          : value
            ? services.cipher.encrypt(value).toString('base64')
            : undefined
      const passwordEnc = secret(input.password, current.passwordEnc)
      const clientSecretEnc = secret(input.clientSecret, current.clientSecretEnc)
      const m365 = input.auth === 'microsoft365'
      const google = input.auth === 'google'
      // The JSON key of the service account: checked, then stored encrypted as a whole.
      const googleKey = input.googleServiceAccountKey
        ? parseGoogleServiceAccountKey(input.googleServiceAccountKey)
        : null
      const googleKeyEnc = googleKey
        ? services.cipher.encrypt(JSON.stringify(googleKey)).toString('base64')
        : input.googleServiceAccountKey === undefined && !destinationChanged
          ? current.googleKeyEnc
          : undefined
      const googleClientEmail =
        googleKey?.clientEmail ?? (googleKeyEnc ? current.googleClientEmail : undefined)
      if (input.enabled && google && (!input.user || !googleKeyEnc)) {
        throw new HttpError(
          400,
          'Für Google Workspace fehlen Postfach-Adresse oder die Schlüsseldatei des Dienstkontos.',
          { googleServiceAccountKey: 'Bitte Postfach-Adresse und Schlüsseldatei angeben.' },
        )
      }
      if (input.enabled && !m365 && !google && (!input.host || !input.user || !passwordEnc)) {
        throw new HttpError(400, 'Für den Abruf fehlen Server, Benutzer oder Passwort.', {
          host: 'Bitte Server, Benutzer und Passwort angeben.',
        })
      }
      if (
        input.enabled &&
        m365 &&
        (!input.user || !input.tenantId || !input.clientId || !clientSecretEnc)
      ) {
        throw new HttpError(
          400,
          'Für Microsoft 365 fehlen Postfach-Adresse, Verzeichnis-ID, Anwendungs-ID oder geheimer Clientschlüssel.',
          { tenantId: 'Bitte alle Angaben der App-Registrierung eintragen.' },
        )
      }
      const stored: StoredMailbox = {
        enabled: input.enabled,
        auth: input.auth,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        ...(input.clientId ? { clientId: input.clientId } : {}),
        ...(clientSecretEnc ? { clientSecretEnc } : {}),
        ...(googleKeyEnc ? { googleKeyEnc } : {}),
        ...(googleClientEmail ? { googleClientEmail } : {}),
        ...(input.clientSecretExpiresOn
          ? { clientSecretExpiresOn: input.clientSecretExpiresOn }
          : input.clientSecretExpiresOn === undefined && current.clientSecretExpiresOn
            ? { clientSecretExpiresOn: current.clientSecretExpiresOn }
            : {}),
        ...(input.host ? { host: input.host } : {}),
        port: input.port,
        secure: input.secure,
        ...(input.user ? { user: input.user } : {}),
        ...(passwordEnc ? { passwordEnc } : {}),
        mailbox: input.mailbox,
        processedMailbox: input.processedMailbox ?? null,
        ...(current.lastRun ? { lastRun: current.lastRun } : {}),
      }
      await tx`update tenant set settings = jsonb_set(settings, '{incomingMail}', ${tx.json(stored as never)})
               where id = current_tenant_id()`
      return view(services, stored)
    })
  })

  /** „Jetzt abrufen“: fetch this company's mailbox now (also to test the settings). */
  app.post('/api/v1/settings/incoming-mail/run', async (request): Promise<IncomingMailRun> => {
    const auth = requirePermission(request, 'settings.write')
    if (!auth.permissions.has('incoming_invoice.write')) {
      throw new HttpError(403, 'Für diese Aktion fehlt die Berechtigung.')
    }
    if (!services.config.INCOMING_MAIL_ENABLED) {
      throw new HttpError(
        409,
        'Der Rechnungseingang per E-Mail ist auf diesem Server nicht freigeschaltet (INCOMING_MAIL_ENABLED in der .env).',
      )
    }
    return pollMailbox(services, auth.tenantId, connector)
  })

  if (options.poll && services.config.INCOMING_MAIL_ENABLED) {
    let timer: NodeJS.Timeout | undefined
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        await pollIncomingMailboxes(services, connector, app.log)
      } catch (err) {
        app.log.error({ err }, 'incoming mailbox poll failed')
      } finally {
        running = false
      }
    }
    app.addHook('onReady', async () => {
      timer = setInterval(tick, (options.intervalMinutes ?? 5) * 60_000)
      void tick()
    })
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer)
    })
  }
}
