import type { Tx } from '@opc/db'
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_DOCUMENT_TYPES,
  EMAIL_PLACEHOLDERS,
  type EmailDocumentType,
  type EmailTemplate,
  fillEmailTemplate,
  formatCents,
} from '@opc/domain'
import { germanDate } from '@opc/exports'
import { documentTitle } from '@opc/pdf-templates'
import {
  type DocumentDetail,
  type DocumentEmailDraft,
  type DocumentEmailEntry,
  type EmailTemplateSettings,
  type EmailTemplatesRequest,
  emailTemplatesRequest,
  sendDocumentEmailRequest,
} from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { attachmentFiles, documentFileName, documentSettings } from './document-settings.js'
import { loadDocument } from './documents.js'
import { queueEmail } from './email.js'
import { archiveDocumentPdf } from './pdf.js'

/**
 * Dokumente per E-Mail (P2.1): the archived original goes out as attachment – for invoices and
 * credit notes the ZUGFeRD PDF (whose XML passed KoSIT at finalization, rule 8), optionally the
 * archived XRechnung XML – with subject and text from the company's templates. The worker marks
 * the document as sent once the SMTP server accepted the message (migration 0028).
 */

const idParam = z.object({ id: z.uuid('Ungültige ID.') })
const ISO = (tx: Tx, column: string) =>
  tx.unsafe(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)

interface StoredEmailSettings {
  bcc?: string | null
  templates?: Partial<Record<EmailDocumentType, EmailTemplate>>
}

async function storedSettings(tx: Tx): Promise<StoredEmailSettings> {
  const [row] = await tx<{ email: StoredEmailSettings | null }[]>`
    select settings -> 'email' as email from tenant where id = current_tenant_id()`
  return row?.email ?? {}
}

export async function emailTemplateSettings(tx: Tx): Promise<EmailTemplateSettings> {
  const stored = await storedSettings(tx)
  const templates = Object.fromEntries(
    EMAIL_DOCUMENT_TYPES.map((type) => {
      const own = stored.templates?.[type]
      return [type, { ...(own ?? DEFAULT_EMAIL_TEMPLATES[type]), custom: Boolean(own) }]
    }),
  ) as EmailTemplateSettings['templates']
  return {
    bcc: stored.bcc ?? null,
    templates,
    defaults: DEFAULT_EMAIL_TEMPLATES,
    placeholders: [...EMAIL_PLACEHOLDERS],
  }
}

const isBilled = (doc: Pick<DocumentDetail, 'type'>) =>
  doc.type === 'invoice' || doc.type === 'credit_note'

interface ArtifactRow {
  id: string
  kind: 'pdf' | 'zugferd_pdf' | 'xrechnung_xml'
  format: string | null
}

async function originalsOf(tx: Tx, doc: DocumentDetail) {
  const pdfName = await documentFileName(tx, doc)
  const rows = await tx<ArtifactRow[]>`
    select id, kind, format from document_artifact
    where document_id = ${doc.id} and kind in ('pdf', 'zugferd_pdf', 'xrechnung_xml')
    order by created_at`
  // The invoice PDF is the ZUGFeRD PDF; documents finalized before e-invoicing have a plain PDF.
  const pdf = rows.find((r) => r.kind === 'zugferd_pdf') ?? rows.find((r) => r.kind === 'pdf')
  const xmls = rows.filter((r) => r.kind === 'xrechnung_xml')
  const xmlName = (row: ArtifactRow) =>
    `${doc.number}_${row.format === 'xrechnung_cii' && xmls.length > 1 ? 'xrechnung_cii' : 'xrechnung'}.xml`
  return {
    pdf: pdf ? { artifactId: pdf.id, filename: pdfName } : null,
    xrechnung: xmls.map((row) => ({ artifactId: row.id, filename: xmlName(row) })),
  }
}

/** E-mail address of the recipient: e-invoice address for invoices, else the contact's e-mail. */
async function recipientOf(tx: Tx, doc: DocumentDetail): Promise<string | null> {
  const snapshot = isBilled(doc) ? (doc.recipient?.einvoiceEmail ?? null) : null
  if (snapshot) return snapshot
  if (!doc.contact) return doc.recipient?.einvoiceEmail ?? null
  const [row] = await tx<{ channel: string | null; einvoice: string | null }[]>`
    select (select value from contact_channel where contact_id = ${doc.contact.id} and kind = 'email'
            order by is_primary desc, id limit 1) as channel,
           (select einvoice_email from contact where id = ${doc.contact.id}) as einvoice`
  return isBilled(doc)
    ? (row?.einvoice ?? row?.channel ?? null)
    : (row?.channel ?? row?.einvoice ?? null)
}

function blockedReason(doc: DocumentDetail): string | null {
  if (!doc.finalizedAt || doc.status === 'draft') {
    return isBilled(doc)
      ? 'Bitte die Rechnung zuerst festschreiben; Entwürfe werden nicht versendet.'
      : 'Bitte das Dokument zuerst fertigstellen; Entwürfe werden nicht versendet.'
  }
  if (doc.status === 'cancelled') {
    return 'Die Rechnung ist storniert. Bitte stattdessen die Stornorechnung senden.'
  }
  return null
}

async function historyOf(tx: Tx, documentId: string): Promise<DocumentEmailEntry[]> {
  return tx<DocumentEmailEntry[]>`
    select m.id, m.to_address as "to", m.cc_addresses as cc, m.bcc_addresses as bcc, m.subject, m.status,
           m.attempts, m.last_error as "lastError",
           coalesce((select array_agg(e.filename order by e.position, e.id) from email_attachment e
                     where e.email_message_id = m.id), '{}') as attachments,
           ${ISO(tx, 'm.created_at')} as "createdAt", ${ISO(tx, 'm.sent_at')} as "sentAt",
           u.display_name as "createdBy"
    from email_message m left join app_user u on u.id = m.created_by
    where m.document_id = ${documentId}
    order by m.created_at desc limit 20`
}

async function draftOf(
  tx: Tx,
  services: Services,
  doc: DocumentDetail,
): Promise<DocumentEmailDraft> {
  const settings = await emailTemplateSettings(tx)
  const template = settings.templates[doc.type]
  const values = {
    Dokument: documentTitle(doc),
    Nummer: doc.number,
    Datum: germanDate(doc.documentDate),
    Betrag: formatCents(BigInt(isBilled(doc) ? doc.totals.payableCents : doc.grossTotalCents)),
    Fällig: germanDate(doc.dueDate ?? doc.documentDate),
    Projekt: doc.project.name,
    Kunde: doc.recipient?.name ?? doc.contact?.displayName ?? null,
    Firma: doc.issuer.name,
  }
  const originals = await originalsOf(tx, doc)
  const recommended =
    isBilled(doc) &&
    (doc.recipient?.einvoiceFormat === 'xrechnung_ubl' ||
      doc.recipient?.einvoiceFormat === 'xrechnung_cii' ||
      Boolean(doc.recipient?.buyerReference))
  return {
    enabled: services.config.SMTP_ENABLED,
    blocked: blockedReason(doc),
    to: await recipientOf(tx, doc),
    cc: [],
    bcc: settings.bcc ? [settings.bcc] : [],
    subject: fillEmailTemplate(template.subject, values),
    text: fillEmailTemplate(template.body, values),
    attachments: [
      { filename: originals.pdf?.filename ?? (await documentFileName(tx, doc)), kind: 'pdf' },
    ],
    xrechnung: {
      available: originals.xrechnung.length > 0,
      recommended: recommended && originals.xrechnung.length > 0,
      filenames: originals.xrechnung.map((x) => x.filename),
    },
    files: await filesOf(tx, doc),
    history: await historyOf(tx, doc.id),
  }
}

/** Company files (AGB …); the automatic attachments of the document type are preselected. */
async function filesOf(tx: Tx, doc: DocumentDetail) {
  const selected = new Set((await documentSettings(tx)).attachments[doc.type] ?? [])
  return (await attachmentFiles(tx)).map((f) => ({
    id: f.id,
    filename: f.name,
    sizeBytes: f.sizeBytes,
    selected: selected.has(f.id),
  }))
}

async function requireDocument(tx: Tx, auth: AuthContext, id: string) {
  const doc = await loadDocument(tx, auth, id)
  if (!doc) throw notFound('Das Dokument')
  return doc
}

export function registerDocumentEmailRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/documents/:id/email', async (request): Promise<DocumentEmailDraft> => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, async (tx) =>
      draftOf(tx, services, await requireDocument(tx, auth, id)),
    )
  })

  app.post('/api/v1/documents/:id/email', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(idParam, request.params)
    const input = parse(sendDocumentEmailRequest, request.body)
    if (!services.config.SMTP_ENABLED) {
      throw new HttpError(
        409,
        'Der E-Mail-Versand ist nicht eingerichtet (SMTP_HOST und SMTP_FROM in der .env). Bitte das PDF herunterladen und selbst versenden.',
      )
    }
    // The PDF original exists after finalizing; create it now if that failed once (best effort).
    const missing = await inTenant(services, auth, async (tx) => {
      const doc = await requireDocument(tx, auth, id)
      const blocked = blockedReason(doc)
      if (blocked) throw new HttpError(409, blocked)
      return !(await originalsOf(tx, doc)).pdf
    })
    if (missing) await archiveDocumentPdf(services, auth, id)
    const draft = await inTenant(services, auth, async (tx) => {
      const doc = await requireDocument(tx, auth, id)
      const originals = await originalsOf(tx, doc)
      if (!originals.pdf)
        throw new HttpError(500, 'Das PDF des Dokuments konnte nicht erstellt werden.')
      if (input.attachXrechnung && !originals.xrechnung.length) {
        throw new HttpError(409, 'Zu diesem Dokument gibt es keine XRechnung.', {
          attachXrechnung: 'Keine XRechnung vorhanden.',
        })
      }
      const automatic = (await documentSettings(tx)).attachments[doc.type] ?? []
      const fileIds = [...new Set(input.fileIds ?? automatic)]
      const files = fileIds.length
        ? await tx<{ id: string; name: string }[]>`
            select id, name from tenant_asset where kind = 'attachment' and id in ${tx(fileIds)}`
        : []
      if (files.length !== fileIds.length) {
        throw new HttpError(400, 'Ein Anhang wurde nicht gefunden.', {
          fileIds: 'Unbekannter Anhang.',
        })
      }
      await queueEmail(tx, auth, {
        kind: 'document',
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
        documentId: id,
        attachments: [
          originals.pdf,
          ...(input.attachXrechnung ? originals.xrechnung : []),
          ...fileIds.map((fid) => {
            const file = files.find((f) => f.id === fid) as { id: string; name: string }
            return { assetId: file.id, filename: file.name }
          }),
        ],
      })
      return draftOf(tx, services, doc)
    })
    return reply.status(202).send(draft)
  })

  app.get('/api/v1/settings/email-templates', async (request) => {
    const auth = requirePermission(request, 'settings.read')
    return inTenant(services, auth, emailTemplateSettings)
  })

  app.put('/api/v1/settings/email-templates', async (request) => {
    const auth = requirePermission(request, 'settings.write')
    const input: EmailTemplatesRequest = parse(emailTemplatesRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      // Templates equal to the default are not stored, so later default improvements apply.
      const templates = Object.fromEntries(
        Object.entries(input.templates).filter(([type, t]) => {
          const base = DEFAULT_EMAIL_TEMPLATES[type as EmailDocumentType]
          return t && (t.subject !== base.subject || t.body !== base.body)
        }),
      )
      const stored = { bcc: input.bcc, templates }
      await tx`update tenant set settings = jsonb_set(settings, '{email}', ${tx.json(stored as never)})
               where id = current_tenant_id()`
      return emailTemplateSettings(tx)
    })
  })
}
