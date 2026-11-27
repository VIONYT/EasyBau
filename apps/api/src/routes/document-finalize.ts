import { createHash } from 'node:crypto'
import { finalizeRequest } from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { legalNotesOf, lockProjectBilling } from '../billing.js'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { restrictedContact, usableContact } from './contacts.js'
import { loadDocument, lockDraft, recalculate, sendDocument } from './documents.js'
import { finalizeInvoice } from './invoices.js'
import { archiveDocumentPdf } from './pdf.js'

/**
 * Fertigstellen / Festschreiben (rule 2, 3). Its own module: it calls into invoices and pdf, which
 * both use the document loaders, so keeping it in documents.ts made import cycles.
 */

const documentParam = z.object({ id: z.uuid('Ungültige ID.') })

export function registerDocumentFinalizeRoutes(app: FastifyInstance, services: Services) {
  // ---- Fertigstellen: number, snapshots, content hash; afterwards unchangeable (rule 2) ------------

  app.post('/api/v1/documents/:id/finalize', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(documentParam, request.params)
    const doc = await inTenant(services, auth, async (tx) => {
      await lockProjectBilling(tx, id)
      const current = await lockDraft(tx, auth, id)
      const [d] = await tx<
        {
          type: string
          contactId: string | null
          contactPersonId: string | null
          documentDate: string
          version: number
        }[]
      >`
        select type, contact_id as "contactId", contact_person_id as "contactPersonId",
               to_char(document_date, 'YYYY-MM-DD') as "documentDate", version
        from document where id = ${id}`
      if (!d) throw notFound('Das Dokument')
      // DSGVO: a contact blocked or erased after the draft was created must not be frozen into a
      // new finalized document (security audit run-1).
      for (const contactId of [d.contactId, d.contactPersonId]) {
        if (contactId && !(await usableContact(tx, contactId))) throw restrictedContact()
      }
      if (d.type === 'invoice' || d.type === 'credit_note') {
        await finalizeInvoice(tx, auth, id, parse(finalizeRequest, request.body ?? {}))
        return loadDocument(tx, auth, id)
      }
      if (!d.contactId) {
        throw new HttpError(400, 'Bitte zuerst einen Empfänger wählen.', {
          contactId: 'Empfänger fehlt.',
        })
      }
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from document_item
        where document_id = ${id} and position_type in ('item', 'alternative', 'optional', 'lump_sum')`
      if (!count?.n) throw new HttpError(409, 'Das Dokument enthält noch keine Positionen.')

      let number: string
      if (d.type === 'change_order') {
        const [meta] = await tx<{ n: number; contractNumber: string | null }[]>`
          select m.number as n, c.number as "contractNumber"
          from change_order_meta m join document c on c.id = m.contract_document_id
          where m.document_id = ${id}`
        if (!meta?.contractNumber) {
          throw new HttpError(
            409,
            'Bitte zuerst die Auftragsbestätigung (Hauptauftrag) fertigstellen.',
          )
        }
        number = `${meta.contractNumber}/N${String(meta.n).padStart(2, '0')}`
      } else if (d.version > 1) {
        // Angebotsversion: number of version 1 with "-V2", "-V3" … (no new number from the sequence).
        const [root] = await tx<{ number: string | null }[]>`
          with recursive up as (
            select id, previous_version_id, number from document where id = ${id}
            union all
            select p.id, p.previous_version_id, p.number from document p join up on p.id = up.previous_version_id
          )
          select number from up where previous_version_id is null`
        if (!root?.number) throw new HttpError(409, 'Die erste Version hat noch keine Nummer.')
        number = `${root.number}-V${d.version}`
      } else {
        const [next] = await tx<
          { n: string }[]
        >`select next_number(${d.type}, ${d.documentDate}::date) as n`
        number = (next as { n: string }).n
      }
      await recalculate(tx, id)
      const preview = await loadDocument(tx, auth, id)
      if (!preview) throw notFound('Das Dokument')
      const { etag: _, updatedAt: __, ...content } = { ...preview, number }
      const hash = createHash('sha256').update(JSON.stringify(content)).digest()
      await tx`
        update document set number = ${number}, status = 'finalized', finalized_at = now(),
               finalized_by = ${auth.userId}, content_hash = ${hash},
               issuer_snapshot = ${tx.json(preview.issuer as never)},
               recipient_snapshot = ${tx.json(preview.recipient as never)},
               legal_notes = ${tx.json(legalNotesOf(preview))}
        where id = ${id} and project_id = ${current.projectId}`
      return loadDocument(tx, auth, id)
    })
    // Archive the PDF/A original right away (best effort, a later download archives as well).
    await archiveDocumentPdf(services, auth, id).catch((error: unknown) =>
      request.log.warn({ err: error }, 'PDF archiving after finalize failed'),
    )
    return sendDocument(reply, doc)
  })
}
