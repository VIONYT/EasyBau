import type { Config } from '@opc/config'
import type { Sql } from '@opc/db'
import nodemailer from 'nodemailer'
import type { Logger } from 'pino'

export interface OutgoingMail {
  from: string
  to: string
  cc?: string[]
  bcc?: string[]
  replyTo?: string
  subject: string
  text: string
  attachments?: { filename: string; content: Buffer; contentType: string }[]
}

/** Reads an archived original: working copy in the files volume, else the WORM archive. */
export type ArtifactReader = (storageKey: string) => Promise<Buffer | null>

/** Sends one message; throws on failure (the outbox retries later). */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>
}

export function smtpTransport(
  config: Pick<Config, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASSWORD'>,
): MailTransport {
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    // STARTTLS is required when not using implicit TLS: no plaintext passwords on the wire.
    requireTLS: !config.SMTP_SECURE,
    ...(config.SMTP_USER
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } }
      : {}),
  })
  return {
    send: async (mail) => {
      await transporter.sendMail(mail)
    },
  }
}

interface ClaimedMessage {
  id: string
  to_address: string
  reply_to: string | null
  subject: string
  body_text: string | null
  cc_addresses: string[] | null
  bcc_addresses: string[] | null
}

/**
 * Sends due messages of the outbox (all companies) once. Uses the restricted runtime role:
 * the database functions claim_email_messages / finish_email_message are the only access.
 * Returns the number of messages sent successfully.
 */
export async function dispatchEmails(
  sql: Sql,
  transport: MailTransport,
  from: string,
  logger: Pick<Logger, 'warn' | 'debug'>,
  limit = 10,
  readArtifact?: ArtifactReader,
): Promise<number> {
  const messages = await sql<ClaimedMessage[]>`select * from claim_email_messages(${limit})`
  let sent = 0
  for (const message of messages) {
    try {
      const files = await sql<{ filename: string; storage_key: string; mime_type: string }[]>`
        select * from email_message_attachments(${message.id})`
      const attachments: NonNullable<OutgoingMail['attachments']> = []
      for (const file of files) {
        const content = readArtifact ? await readArtifact(file.storage_key) : null
        if (!content) throw new Error(`attachment ${file.filename} is not readable`)
        attachments.push({ filename: file.filename, content, contentType: file.mime_type })
      }
      await transport.send({
        from,
        to: message.to_address,
        ...(message.cc_addresses?.length ? { cc: message.cc_addresses } : {}),
        ...(message.bcc_addresses?.length ? { bcc: message.bcc_addresses } : {}),
        ...(message.reply_to ? { replyTo: message.reply_to } : {}),
        subject: message.subject,
        text: message.body_text ?? '',
        ...(attachments.length ? { attachments } : {}),
      })
      await sql`select finish_email_message(${message.id}, true, null)`
      sent += 1
    } catch (error) {
      // No addresses or content in the log (CLAUDE.md rule 9), only the id and the reason.
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn({ emailId: message.id, reason }, 'e-mail could not be sent')
      await sql`select finish_email_message(${message.id}, false, ${reason})`
    }
  }
  if (sent) logger.debug({ sent }, 'e-mails sent')
  return sent
}
