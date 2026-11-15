import type { Tx } from '@opc/db'
import {
  type IncomingMailAuth,
  type IncomingMailRun,
  type IncomingMailSettings,
  incomingMailSettingsRequest,
} from '@opc/schemas'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, parse } from '../http.js'
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
}

export interface MailboxConnection {
  /** Unread messages, oldest first, at most `limit`. */
  unread(limit: number): Promise<MailMessage[]>
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
  /** IMAP LOGIN; null with Microsoft 365 (OAuth2). */
  password: string | null
  oauth: MicrosoftOAuth | null
  mailbox: string
  processedMailbox: string | null
}

export type MailboxConnector = (access: MailboxAccess) => Promise<MailboxConnection>

const MESSAGES_PER_RUN = 25
const INVOICE_EXTENSIONS = /\.(pdf|xml|jpe?g|png)$/i
const M365_IMAP_HOST = 'outlook.office365.com'

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
    async unread(limit) {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []).slice(0, limit)
      const messages: MailMessage[] = []
      for (const uid of uids) {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true })
        if (message === false || !message.source) continue
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
      oauth: {
        tenantId: stored.tenantId,
        clientId: stored.clientId,
        clientSecret: decrypt(services, stored.clientSecretEnc),
      },
    }
  }
  if (!stored.host || !stored.passwordEnc) return null
  return {
    ...common,
    host: stored.host,
    password: decrypt(services, stored.passwordEnc),
    oauth: null,
  }
}

/** Short reason without addresses or content (rule 9: no PII in logs or stored errors). */
function reasonOf(error: unknown, access: MailboxAccess): string {
  if (error instanceof HttpError) return error.message
  if (error instanceof MicrosoftTokenError) {
    return 'Anmeldung bei Microsoft 365 fehlgeschlagen (Verzeichnis-ID, Anwendungs-ID oder geheimer Clientschlüssel prüfen).'
  }
  const e = error as { authenticationFailed?: boolean; code?: string; name?: string }
  if (e.authenticationFailed) {
    return access.oauth
      ? 'Microsoft 365 hat die Anmeldung am Postfach abgelehnt (IMAP-Berechtigung der App und Freigabe des Postfachs für die App prüfen).'
      : 'Anmeldung am Postfach fehlgeschlagen (Benutzer oder Passwort).'
  }
  if (e.name === 'TimeoutError') return 'Microsoft 365 hat nicht rechtzeitig geantwortet.'
  if (e.code === 'ENOTFOUND') return 'Der Mailserver wurde nicht gefunden.'
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT')
    return 'Der Mailserver ist nicht erreichbar.'
  return 'Das Postfach konnte nicht abgerufen werden.'
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
  }
  if (!access) {
    run.error = 'Das Postfach ist nicht vollständig eingerichtet.'
  } else {
    let connection: MailboxConnection | null = null
    try {
      connection = await connector(access)
      for (const message of await connection.unread(MESSAGES_PER_RUN)) {
        run.messages += 1
        let retry = false
        for (const attachment of message.attachments) {
          // Pictures embedded in the text (signature logos) are no invoices; PDFs/XML always count.
          const embeddedPicture = attachment.inline && !/\.(pdf|xml)$/i.test(attachment.filename)
          if (!INVOICE_EXTENSIONS.test(attachment.filename) || embeddedPicture) {
            run.ignored += 1
            continue
          }
          try {
            await ingestIncomingInvoice(
              services,
              system,
              { filename: attachment.filename, data: attachment.content },
              { via: 'email', from: message.from, subject: message.subject },
            )
            run.imported += 1
          } catch (error) {
            const status = error instanceof HttpError ? error.statusCode : 500
            if (status === 409) run.duplicates += 1
            else if (status === 415 || status === 400 || status === 413) run.ignored += 1
            else {
              // Temporary (database, storage): the message stays unread and is tried again.
              run.failed += 1
              retry = true
            }
          }
        }
        if (!retry) await connection.done(message.uid)
      }
    } catch (error) {
      run.error = reasonOf(error, access)
    } finally {
      await connection?.close().catch(() => undefined)
    }
  }
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
    >`select pg_try_advisory_lock(hashtext('opc.incoming_mail')) as ok`
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
      await reserved`select pg_advisory_unlock(hashtext('opc.incoming_mail'))`
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

  app.put('/api/v1/settings/incoming-mail', async (request): Promise<IncomingMailSettings> => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(incomingMailSettingsRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const current = await storedMailbox(tx)
      // undefined keeps the stored secret, '' or null removes it.
      const secret = (value: string | null | undefined, stored: string | undefined) =>
        value === undefined
          ? stored
          : value
            ? services.cipher.encrypt(value).toString('base64')
            : undefined
      const passwordEnc = secret(input.password, current.passwordEnc)
      const clientSecretEnc = secret(input.clientSecret, current.clientSecretEnc)
      const m365 = input.auth === 'microsoft365'
      if (input.enabled && !m365 && (!input.host || !input.user || !passwordEnc)) {
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
