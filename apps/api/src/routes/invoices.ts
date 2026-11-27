import { createHash } from 'node:crypto'
import type { Tx } from '@easybau/db'
import { addDays } from '@easybau/domain'
import {
  type CancelInvoiceResult,
  cancelInvoiceRequest,
  type FinalizeCheck,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { billingDoc, invoiceFinalizeCheck, legalNotesOf, lockProjectBilling } from '../billing.js'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { issueEinvoices } from '../einvoice.js'
import { HttpError, notFound, parse } from '../http.js'
import { copyItems, liveIssuer, loadDocument, lockDraft, recalculate } from './documents.js'
import { archiveDocumentPdf } from './pdf.js'
import { markReportsBilled } from './report-billing.js'

const documentParam = z.object({ id: z.uuid('Ungültige ID.') })

async function issuerData(tx: Tx) {
  const [row] = await tx<
    {
      street: string | null
      postalCode: string | null
      city: string | null
      taxNumber: string | null
      vatId: string | null
    }[]
  >`
    select street, postal_code as "postalCode", city, tax_number as "taxNumber", vat_id as "vatId"
    from tenant where id = current_tenant_id()`
  return row ?? { street: null, postalCode: null, city: null, taxNumber: null, vatId: null }
}

const sequenceOf = (type: string) => (type === 'credit_note' ? 'credit_note' : 'invoice')

/** Messages grouped per field (several problems for the same field are joined). */
function byField(issues: { field: string; message: string }[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const issue of issues) {
    result[issue.field] = result[issue.field]
      ? `${result[issue.field]} ${issue.message}`
      : issue.message
  }
  return result
}

/** Pflichtangaben, Regel 12 and current quantities; the number is only previewed. */
export async function checkInvoice(tx: Tx, auth: AuthContext, id: string): Promise<FinalizeCheck> {
  const doc = await billingDoc(tx, id)
  const detail = await loadDocument(tx, auth, id)
  if (!doc || !detail) throw notFound('Das Dokument')
  if (doc.type !== 'invoice' && doc.type !== 'credit_note') {
    return { errors: [], warnings: [], numberPreview: null }
  }
  const check = await invoiceFinalizeCheck(tx, doc, detail, await issuerData(tx))
  let numberPreview: string | null = null
  if (doc.status === 'draft') {
    // Draw the number inside a savepoint and roll it back: nothing is consumed.
    await tx
      .savepoint(async (sp) => {
        const [row] = await sp<{ n: string }[]>`
          select next_number(${sequenceOf(doc.type)}, ${detail.documentDate}::date) as n`
        numberPreview = row?.n ?? null
        throw new Error('rollback')
      })
      .catch(() => undefined)
  }
  return { ...check, numberPreview }
}

/**
 * Festschreiben einer Rechnung/Gutschrift (DESIGN.md §4.1) in one transaction: checks, number by
 * document date, snapshots (rule 4), legal notes, due date, content hash; used measurement lines
 * are locked (rule 12). Immutable afterwards (rule 2, DB triggers).
 */
export async function finalizeInvoice(
  tx: Tx,
  auth: AuthContext,
  id: string,
  input: { acknowledgeWarnings: boolean },
): Promise<void> {
  if (!auth.permissions.has('document.finalize')) {
    throw new HttpError(403, 'Ihnen fehlt die Berechtigung, Rechnungen festzuschreiben.')
  }
  await lockProjectBilling(tx, id)
  const current = await lockDraft(tx, auth, id)
  await recalculate(tx, id)
  const check = await checkInvoice(tx, auth, id)
  if (check.errors.length) {
    throw new HttpError(
      409,
      'Die Rechnung kann noch nicht festgeschrieben werden. Bitte die markierten Angaben ergänzen.',
      byField(check.errors),
    )
  }
  if (check.warnings.length && !input.acknowledgeWarnings) {
    throw new HttpError(
      409,
      'Bitte die Hinweise prüfen und das Festschreiben bestätigen.',
      byField(check.warnings),
    )
  }
  const detail = await loadDocument(tx, auth, id)
  if (!detail) throw notFound('Das Dokument')
  const [next] = await tx<{ n: string }[]>`
    select next_number(${sequenceOf(detail.type)}, ${detail.documentDate}::date) as n`
  const number = (next as { n: string }).n
  const dueDate =
    detail.paymentDueDays === null ? null : addDays(detail.documentDate, detail.paymentDueDays)
  const legalNotes = legalNotesOf(detail)

  // Rule 12: the Leistungsaufmaß lines behind quantities of this invoice become immutable.
  await tx`
    update measurement_line l set locked_by_invoice_id = ${id}
    where l.locked_by_invoice_id is null and l.document_item_id is not null
      and exists (select 1 from measurement_sheet s
                  where s.id = l.sheet_id and s.kind = 'performance' and s.project_id = ${current.projectId})
      and document_item_root(l.document_item_id) in (
        select document_item_root(i.id) from document_item i
        where i.document_id = ${id} and i.quantity_from_measurement)`

  const { etag: _, updatedAt: __, ...content } = { ...detail, number, legalNotes, dueDate }
  const hash = createHash('sha256').update(JSON.stringify(content)).digest()
  await tx`
    update document set number = ${number}, status = 'finalized', finalized_at = now(),
           finalized_by = ${auth.userId}, content_hash = ${hash}, due_date = ${dueDate},
           issuer_snapshot = ${tx.json(detail.issuer as never)},
           recipient_snapshot = ${tx.json(detail.recipient as never)},
           legal_notes = ${tx.json(legalNotes)}
    where id = ${id} and project_id = ${current.projectId}`
  // Regie-/Einsatzberichte in this invoice are billed now (P2.5).
  await markReportsBilled(tx, id)

  // Rule 8: ZUGFeRD/XRechnung from the frozen document, validated by KoSIT, archived. A failed
  // check rolls the whole transaction back: no number is consumed, the invoice stays a draft.
  const finalized = await loadDocument(tx, auth, id)
  if (!finalized) throw notFound('Das Dokument')
  await issueEinvoices(tx, finalized, auth)
}

/**
 * Storno: a Stornorechnung (own number) mirrors the invoice with negated quantities, tax lines and
 * deductions and is finalized at once; the DB trigger then marks the invoice as cancelled
 * (migration 0015). The cancelled invoice keeps its number and stays locked for good.
 * `reissue` creates a copy of the original as a new draft („Rechnung korrigieren“).
 */
export async function cancelInvoice(
  tx: Tx,
  auth: AuthContext,
  id: string,
  input: { reason: string; reissue: boolean },
): Promise<CancelInvoiceResult> {
  const original = await loadDocument(tx, auth, id)
  if (!original) throw notFound('Die Rechnung')
  await lockProjectBilling(tx, id)
  await tx`select id from document where id = ${id} for update`
  if (original.type !== 'invoice' || original.invoiceKind === 'cancellation') {
    throw new HttpError(409, 'Stornieren lässt sich nur eine Rechnung, keine Stornorechnung.')
  }
  if (original.status === 'draft') {
    throw new HttpError(409, 'Ein Entwurf hat noch keine Nummer und kann einfach gelöscht werden.')
  }
  if (original.status === 'cancelled') {
    throw new HttpError(409, `Die Rechnung ${original.number} ist bereits storniert.`)
  }
  const [deducting] = await tx<{ number: string }[]>`
    select d.number from document_deduction dd join document d on d.id = dd.document_id
    where dd.deducted_document_id = ${id} and d.finalized_at is not null
      and d.status <> 'cancelled' and d.invoice_kind <> 'cancellation'
    limit 1`
  if (deducting) {
    throw new HttpError(
      409,
      `Diese Rechnung ist in der Rechnung ${deducting.number} angerechnet. Bitte zuerst ${deducting.number} stornieren.`,
    )
  }

  // 1. Stornorechnung as a draft: same recipient, place and tax case; positions negated.
  const [created] = await tx<{ id: string }[]>`
    insert into document (tenant_id, project_id, type, invoice_kind, cancels_document_id, cancel_reason,
                          subject, document_date, service_from, service_to, place_of_performance,
                          contact_id, tax_mode, currency, discount_percent, retention_percent,
                          construction_levy_percent, source_document_id, created_by)
    select tenant_id, project_id, 'invoice', 'cancellation', id, ${input.reason},
           subject, current_date, service_from, service_to,
           place_of_performance, contact_id, tax_mode, currency, discount_percent, retention_percent,
           construction_levy_percent, id, ${auth.userId}
    from document where id = ${id}
    returning id`
  const cancellationId = (created as { id: string }).id
  await copyItems(tx, id, cancellationId)
  await tx`
    update document_item set quantity = -quantity, total_cents = -total_cents,
           cumulative_quantity = null, previously_billed_quantity = null
    where document_id = ${cancellationId}`
  await tx`
    insert into document_tax_line (tenant_id, document_id, tax_category, rate_percent, net_cents, tax_cents, exemption_reason)
    select tenant_id, ${cancellationId}, tax_category, rate_percent, -net_cents, -tax_cents, exemption_reason
    from document_tax_line where document_id = ${id}`
  await tx`
    insert into document_deduction (tenant_id, document_id, deducted_document_id, net_cents, tax_cents, gross_cents)
    select tenant_id, ${cancellationId}, deducted_document_id, -net_cents, -tax_cents, -gross_cents
    from document_deduction where document_id = ${id}`
  await tx`
    update document c set net_total_cents = -o.net_total_cents, tax_total_cents = -o.tax_total_cents,
           gross_total_cents = -o.gross_total_cents, payable_cents = -coalesce(o.payable_cents, o.gross_total_cents)
    from document o where o.id = ${id} and c.id = ${cancellationId}`

  // 2. Finalize the Stornorechnung immediately (own number, never reused).
  const detail = await loadDocument(tx, auth, cancellationId)
  if (!detail) throw notFound('Die Stornorechnung')
  const [next] = await tx<{ n: string }[]>`
    select next_number('invoice', ${detail.documentDate}::date) as n`
  const number = (next as { n: string }).n
  const issuer = await liveIssuer(tx)
  const legalNotes = legalNotesOf({ ...detail, issuer, recipient: original.recipient })
  const {
    etag: _,
    updatedAt: __,
    ...content
  } = {
    ...detail,
    number,
    issuer,
    recipient: original.recipient,
    legalNotes,
  }
  const hash = createHash('sha256').update(JSON.stringify(content)).digest()
  await tx`
    update document set number = ${number}, status = 'finalized', finalized_at = now(),
           finalized_by = ${auth.userId}, content_hash = ${hash},
           issuer_snapshot = ${tx.json(issuer as never)},
           recipient_snapshot = ${tx.json(original.recipient as never)},
           legal_notes = ${tx.json(legalNotes)}
    where id = ${cancellationId}`
  // The Stornorechnung is an e-invoice as well (type 384 with reference to the invoice, rule 8).
  const cancellation = await loadDocument(tx, auth, cancellationId)
  if (!cancellation) throw notFound('Die Stornorechnung')
  await issueEinvoices(tx, cancellation, auth)

  // 3. „Rechnung korrigieren“: the original as a new draft (same kind and Abschlag number).
  let reissue: CancelInvoiceResult['reissue'] = null
  if (input.reissue) {
    const [copy] = await tx<{ id: string }[]>`
      insert into document (tenant_id, project_id, type, invoice_kind, progress_no, progress_billing_mode,
                            subject, service_from, service_to, place_of_performance, contact_id,
                            contact_person_id, tax_mode, currency, intro_text, closing_text,
                            payment_due_days, cash_discount_percent, cash_discount_days, discount_percent,
                            retention_percent, construction_levy_percent, show_labor_share,
                            source_document_id, created_by)
      select tenant_id, project_id, type, invoice_kind, progress_no, progress_billing_mode,
             subject, service_from, service_to, place_of_performance, contact_id,
             contact_person_id, tax_mode, currency, intro_text, closing_text,
             payment_due_days, cash_discount_percent, cash_discount_days, discount_percent,
             retention_percent, construction_levy_percent, show_labor_share, id, ${auth.userId}
      from document where id = ${id}
      returning id`
    const reissueId = (copy as { id: string }).id
    await copyItems(tx, id, reissueId)
    await tx`
      update document_item n set quantity_from_measurement = o.quantity_from_measurement,
             cumulative_quantity = o.cumulative_quantity,
             previously_billed_quantity = o.previously_billed_quantity
      from document_item o where n.document_id = ${reissueId} and o.id = n.source_item_id`
    await recalculate(tx, reissueId)
    reissue = { id: reissueId }
  }
  return { cancellation: { id: cancellationId, number }, reissue }
}

export function registerInvoiceRoutes(app: FastifyInstance, services: Services) {
  app.post('/api/v1/documents/:id/cancel', async (request, reply) => {
    const auth = requirePermission(request, 'document.cancel')
    const { id } = parse(documentParam, request.params)
    const input = parse(cancelInvoiceRequest, request.body ?? {})
    const result = await inTenant(services, auth, (tx) => cancelInvoice(tx, auth, id, input))
    await archiveDocumentPdf(services, auth, result.cancellation.id).catch((error: unknown) =>
      request.log.warn({ err: error }, 'PDF archiving after cancellation failed'),
    )
    return reply.status(201).send(result)
  })

  app.get('/api/v1/documents/:id/finalize-check', async (request): Promise<FinalizeCheck> => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(documentParam, request.params)
    return inTenant(services, auth, async (tx) => {
      await recalculateIfDraft(tx, id)
      return checkInvoice(tx, auth, id)
    })
  })
}

async function recalculateIfDraft(tx: Tx, id: string) {
  const [row] = await tx<{ status: string }[]>`select status from document where id = ${id}`
  if (row?.status === 'draft') await recalculate(tx, id)
}
