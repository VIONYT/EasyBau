import { Readable } from 'node:stream'
import type { Tx } from '@opc/db'
import { documentLetter, documentTitle, renderLetterPdf } from '@opc/pdf-templates'
import type { DocumentDetail } from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { notFound, parse } from '../http.js'
import { loadDocument } from './documents.js'

const documentParam = z.object({ id: z.uuid('Ungültige ID.') })
const MAX_PDF_BYTES = 50 * 1024 * 1024

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Renders a document as PDF/A-3b (letter per DIN 5008 Form B, A4, letterhead of the snapshot). */
async function render(
  tx: Tx,
  services: Services,
  doc: DocumentDetail,
  watermark: string | null,
): Promise<Buffer> {
  const { logoPosition, ...letter } = documentLetter(doc, { watermark })
  let logo = null
  if (logoPosition) {
    const [asset] = await tx<{ key: string; mime: string }[]>`
      select storage_key as key, mime_type as mime from tenant_asset where id = ${logoPosition.assetId}`
    if (asset) {
      const { assetId: _, ...position } = logoPosition
      logo = {
        ...position,
        data: await readAll(services.storage.read(asset.key)),
        mime: asset.mime,
      }
    }
  }
  return renderLetterPdf(
    { ...letter, logo },
    doc.finalizedAt ? { createdAt: new Date(doc.finalizedAt) } : {},
  )
}

/**
 * PDF of a document. Drafts are rendered on every request (watermark „ENTWURF“). A finalized
 * document is rendered once and archived as document_artifact (insert-only, SHA-256, locked for
 * the retention period); every later request returns exactly that original (GoBD).
 */
export async function documentPdf(
  services: Services,
  auth: AuthContext,
  id: string,
): Promise<{ data: Buffer | Readable; filename: string } | null> {
  return inTenant(services, auth, async (tx) => {
    const doc = await loadDocument(tx, auth, id)
    if (!doc) return null
    const filename = `${documentTitle(doc)}${doc.number ? `_${doc.number}` : '_Entwurf'}.pdf`
    if (!doc.finalizedAt) {
      return { data: await render(tx, services, doc, 'ENTWURF'), filename }
    }
    // Serialise the first rendering of the archived original.
    await tx`select id from document where id = ${id} for update`
    const [archived] = await tx<{ key: string }[]>`
      select storage_key as key from document_artifact
      where document_id = ${id} and kind = 'pdf' order by created_at limit 1`
    if (archived) return { data: services.storage.read(archived.key), filename }

    const pdf = await render(tx, services, doc, null)
    const pending = await services.storage.receive(Readable.from([pdf]), {
      maxBytes: MAX_PDF_BYTES,
    })
    try {
      const [ids] = await tx<{ id: string }[]>`select uuid_v7() as id`
      const artifactId = (ids as { id: string }).id
      const key = `${auth.tenantId}/documents/${id}/${artifactId}`
      // Aufbewahrung: 10 Jahre ab Ende des Kalenderjahres des Belegs (§ 147 AO).
      await tx`
        insert into document_artifact (id, tenant_id, document_id, kind, storage_key, sha256, size_bytes,
                                       mime_type, locked_until)
        select ${artifactId}, tenant_id, id, 'pdf', ${key}, ${pending.sha256}, ${pending.sizeBytes},
               'application/pdf',
               (date_trunc('year', document_date) + interval '11 years' - interval '1 day')::date
        from document where id = ${id}`
      await pending.commit(key)
    } finally {
      await pending.discard()
    }
    return { data: pdf, filename }
  })
}

/** Archives the PDF right after finalizing (best effort; a later download archives as well). */
export async function archiveDocumentPdf(
  services: Services,
  auth: AuthContext,
  id: string,
): Promise<void> {
  const result = await documentPdf(services, auth, id)
  if (result?.data instanceof Readable) result.data.resume()
}

/** RFC 6266 file name: ASCII fallback plus UTF-8 version. */
function contentDisposition(filename: string): string {
  const ascii = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, '_')
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename.replace(/\s+/g, '_'))}`
}

export function registerPdfRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/documents/:id/pdf', async (request, reply) => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(documentParam, request.params)
    const result = await documentPdf(services, auth, id)
    if (!result) throw notFound('Das Dokument')
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', contentDisposition(result.filename))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(result.data)
  })
}
