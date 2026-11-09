import { createHash } from 'node:crypto'
import type { Tx } from '@opc/db'
import { addDays } from '@opc/domain'
import type { FinalizeCheck } from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { billingDoc, invoiceFinalizeCheck, legalNotesOf } from '../billing.js'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { loadDocument, lockDraft, recalculate } from './documents.js'

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
}

export function registerInvoiceRoutes(app: FastifyInstance, services: Services) {
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
