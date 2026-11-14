import type { Tx } from '@opc/db'
import { type EmailMessageSummary, type EmailSettings, testEmailRequest } from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, parse } from '../http.js'

export interface QueuedEmail {
  kind: 'invitation' | 'test' | 'document' | 'dunning' | 'password_reset' | 'email_verify'
  to: string
  subject: string
  text: string
  /** Archived originals or company files (AGB …) sent as attachments (read by the worker). */
  attachments?: (({ artifactId: string } | { assetId: string }) & { filename: string })[]
  dunningNoticeId?: string | null
  /** Dokumente per E-Mail: the document is marked as sent once the server accepted the message. */
  documentId?: string | null
  cc?: string[]
  bcc?: string[]
}

/**
 * Puts a message into the outbox in the caller's transaction: it is sent only if the change
 * commits (same rule as for jobs). Replies go to the company's e-mail address if set.
 */
export async function queueEmail(tx: Tx, auth: AuthContext, mail: QueuedEmail): Promise<string> {
  const [company] = await tx<
    { email: string | null }[]
  >`select email from tenant where id = current_tenant_id()`
  const [row] = await tx<{ id: string }[]>`
    insert into email_message (tenant_id, kind, to_address, reply_to, subject, body_text, created_by,
                               dunning_notice_id, document_id, cc_addresses, bcc_addresses)
    values (${auth.tenantId}, ${mail.kind}, ${mail.to}, ${company?.email ?? null}, ${mail.subject}, ${mail.text},
            ${auth.userId}, ${mail.dunningNoticeId ?? null}, ${mail.documentId ?? null},
            ${mail.cc ?? []}::text[], ${mail.bcc ?? []}::text[])
    returning id`
  const id = (row as { id: string }).id
  for (const [position, attachment] of (mail.attachments ?? []).entries()) {
    await tx`
      insert into email_attachment (tenant_id, email_message_id, artifact_id, asset_id, filename, position)
      values (${auth.tenantId}, ${id}, ${'artifactId' in attachment ? attachment.artifactId : null},
              ${'assetId' in attachment ? attachment.assetId : null}, ${attachment.filename}, ${position})`
  }
  return id
}

export function registerEmailRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/settings/email', async (request): Promise<EmailSettings> => {
    requirePermission(request, 'settings.read')
    return { enabled: services.config.SMTP_ENABLED, from: services.config.SMTP_FROM ?? null }
  })

  app.post('/api/v1/settings/email/test', async (request, reply) => {
    const auth = requirePermission(request, 'settings.write')
    const input = parse(testEmailRequest, request.body)
    if (!services.config.SMTP_ENABLED) {
      throw new HttpError(
        409,
        'Der E-Mail-Versand ist nicht eingerichtet (SMTP_HOST und SMTP_FROM in der .env).',
      )
    }
    await inTenant(services, auth, (tx) =>
      queueEmail(tx, auth, {
        kind: 'test',
        to: input.to ?? auth.email,
        subject: `Test-E-Mail von ${services.config.APP_NAME}`,
        text: `Hallo ${auth.displayName},\n\ndiese Test-E-Mail bestätigt, dass der E-Mail-Versand für ${auth.tenantName} funktioniert.\n`,
      }),
    )
    return reply.status(202).send({ queued: true })
  })

  app.get('/api/v1/settings/email/messages', async (request): Promise<EmailMessageSummary[]> => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(
      services,
      auth,
      (tx) => tx<EmailMessageSummary[]>`
        select id, kind, to_address as "toAddress", subject, status, attempts, last_error as "lastError",
               to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
               to_char(sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "sentAt"
        from email_message order by created_at desc limit 50`,
    )
  })
}
