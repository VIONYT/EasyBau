import { Readable } from 'node:stream'
import type { Tx } from '@opc/db'
import type { LetterheadValues } from '@opc/domain'
import { addFacturXMetadata } from '@opc/einvoice'
import {
  documentLetter,
  documentTitle,
  isUsableImage,
  type LogoPosition,
  renderLetterPdf,
  reportLetter,
  type SiteLetterContext,
  sheetLetter,
} from '@opc/pdf-templates'
import type { DocumentDetail } from '@opc/schemas'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { openArtifact, readArtifact, storeArtifact } from '../artifacts.js'
import {
  type AuthContext,
  inTenant,
  requireAuth,
  requirePermission,
  type Services,
} from '../context.js'
import { notFound, parse } from '../http.js'
import { liveIssuer, liveRecipient, loadDocument } from './documents.js'
import { loadSheet } from './measurements.js'
import { loadReport } from './reports.js'

const documentParam = z.object({ id: z.uuid('Ungültige ID.') })

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export async function logoFor(
  tx: Tx,
  services: Services,
  logoPosition: LogoPosition | null,
): Promise<LetterLogo | null> {
  if (!logoPosition) return null
  const [asset] = await tx<{ key: string; mime: string }[]>`
    select storage_key as key, mime_type as mime from tenant_asset where id = ${logoPosition.assetId}`
  if (!asset) return null
  const { assetId: _, ...position } = logoPosition
  return { ...position, data: await readAll(services.storage.read(asset.key)), mime: asset.mime }
}

type LetterLogo = NonNullable<Parameters<typeof renderLetterPdf>[0]['logo']>

/**
 * Renders a document as PDF/A-3b (letter per DIN 5008 Form B, A4, letterhead of the snapshot).
 * With `einvoiceXml` it becomes a ZUGFeRD/Factur-X invoice: XML attached, Factur-X XMP added.
 */
async function render(
  tx: Tx,
  services: Services,
  doc: DocumentDetail,
  watermark: string | null,
  einvoiceXml?: Buffer,
): Promise<Buffer> {
  const { logoPosition, ...letter } = documentLetter(doc, { watermark })
  const pdf = renderLetterPdf(
    { ...letter, logo: await logoFor(tx, services, logoPosition) },
    {
      ...(doc.finalizedAt ? { createdAt: new Date(doc.finalizedAt) } : {}),
      ...(einvoiceXml ? { einvoiceXml } : {}),
    },
  )
  return einvoiceXml ? addFacturXMetadata(pdf, 'EN 16931') : pdf
}

/** Company frame of Aufmaßblatt and Berichte: live letterhead, customer of the project. */
async function siteContext(tx: Tx, projectId: string): Promise<SiteLetterContext> {
  const issuer = await liveIssuer(tx)
  const [project] = await tx<{ customerId: string | null }[]>`
    select customer_id as "customerId" from project where id = ${projectId}`
  const recipient = await liveRecipient(tx, project?.customerId ?? null)
  return {
    issuerName: issuer.name,
    layout: issuer.letterhead,
    values: (issuer.values ?? {}) as LetterheadValues,
    recipient: recipient ? [recipient.name, ...recipient.lines] : [],
  }
}

/** Handwritten signatures as template assets (/sig-N.png); unreadable images are left out. */
async function signatureAssets(
  tx: Tx,
  services: Services,
  assetIds: (string | null)[],
): Promise<{ images: Map<string, string>; assets: { path: string; data: Buffer }[] }> {
  const ids = [...new Set(assetIds.filter((id): id is string => Boolean(id)))]
  const images = new Map<string, string>()
  const assets: { path: string; data: Buffer }[] = []
  if (!ids.length) return { images, assets }
  const rows = await tx<{ id: string; key: string }[]>`
    select id, storage_key as key from tenant_asset
    where id in ${tx(ids)} and kind = 'signature' and mime_type = 'image/png'`
  for (const [index, row] of rows.entries()) {
    const path = `/sig-${index + 1}.png`
    const data = await readAll(services.storage.read(row.key))
    if (!isUsableImage(path, data)) continue
    images.set(row.id, path)
    assets.push({ path, data })
  }
  return { images, assets }
}

const PHOTO_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const MAX_PHOTOS = 24

/** Aufmaßblatt as PDF/A (rendered on request from the current, for signed sheets locked data). */
export async function sheetPdf(services: Services, auth: AuthContext, id: string) {
  return inTenant(services, auth, async (tx) => {
    const sheet = await loadSheet(tx, auth, id)
    if (!sheet) return null
    const signatures = await signatureAssets(tx, services, [
      sheet.contractorSignatureAssetId,
      sheet.clientSignatureAssetId,
    ])
    const { logoPosition, ...letter } = sheetLetter(sheet, {
      ...(await siteContext(tx, sheet.projectId)),
      signatureImages: signatures.images,
    })
    const pdf = renderLetterPdf(
      { ...letter, logo: await logoFor(tx, services, logoPosition) },
      { assets: signatures.assets },
    )
    return { data: pdf, filename: `Aufmass_${sheet.title}.pdf` }
  })
}

/** Bericht (Bautagebuch, Regiebericht …) as PDF/A with its photos. */
export async function reportPdf(services: Services, auth: AuthContext, id: string) {
  return inTenant(services, auth, async (tx) => {
    const report = await loadReport(tx, auth, id)
    if (!report) return null
    const units = new Map(
      (
        await tx<{ id: string; symbol: string; decimals: number }[]>`
          select id, symbol, decimals from unit`
      ).map((u) => [u.id, { symbol: u.symbol, decimals: u.decimals }]),
    )
    const photos: { path: string; caption: string | null }[] = []
    const assets: { path: string; data: Buffer }[] = []
    const ids = report.photos.slice(0, MAX_PHOTOS).map((p) => p.fileId)
    const files = ids.length
      ? await tx<{ id: string; key: string; mime: string }[]>`
          select id, storage_key as key, mime_type as mime from file where id in ${tx(ids)}`
      : []
    for (const [index, photo] of report.photos.slice(0, MAX_PHOTOS).entries()) {
      const file = files.find((f) => f.id === photo.fileId)
      const extension = file ? PHOTO_TYPES[file.mime] : undefined
      // e.g. HEIC or damaged files: not in the PDF, the original stays in the Ablage
      if (!file || !extension) continue
      const path = `/photo-${index + 1}.${extension}`
      const data = await readAll(services.storage.read(file.key))
      if (!isUsableImage(path, data)) continue
      assets.push({ path, data })
      photos.push({ path, caption: photo.caption })
    }
    const signatures = await signatureAssets(
      tx,
      services,
      report.signatures.map((s) => s.imageAssetId),
    )
    assets.push(...signatures.assets)
    const { logoPosition, ...letter } = reportLetter(report, {
      ...(await siteContext(tx, report.projectId)),
      signatureImages: signatures.images,
      units,
      photos,
      skippedPhotos: Math.min(report.photos.length, MAX_PHOTOS) - photos.length,
    })
    const pdf = renderLetterPdf(
      { ...letter, logo: await logoFor(tx, services, logoPosition) },
      { assets },
    )
    return { data: pdf, filename: `${report.template.name}_${report.reportDate}.pdf` }
  })
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
      where document_id = ${id} and kind in ('pdf', 'zugferd_pdf') order by created_at limit 1`
    if (archived) {
      const original = await openArtifact(services, archived.key)
      if (original) return { data: original, filename }
    }

    // Invoices: the KoSIT-validated ZUGFeRD XML (archived at Festschreiben) goes into the PDF/A-3.
    const [xml] = await tx<{ key: string; validatedAt: string }[]>`
      select storage_key as key, validated_at::text as "validatedAt" from document_artifact
      where document_id = ${id} and kind = 'zugferd_xml' and validated_at is not null
      order by created_at limit 1`
    const einvoiceXml = xml ? await readArtifact(services, xml.key) : undefined
    const pdf = await render(tx, services, doc, null, einvoiceXml)
    await storeArtifact(tx, services, auth, id, {
      kind: xml ? 'zugferd_pdf' : 'pdf',
      data: pdf,
      mime: 'application/pdf',
      ...(xml ? { format: 'zugferd', validatedAt: xml.validatedAt } : {}),
    })
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
export function contentDisposition(filename: string): string {
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

  const sendPdf = (
    reply: FastifyReply,
    result: { data: Buffer; filename: string } | null,
    what: string,
  ) => {
    if (!result) throw notFound(what)
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', contentDisposition(result.filename))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(result.data)
  }

  app.get('/api/v1/measurement-sheets/:id/pdf', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(documentParam, request.params)
    return sendPdf(reply, await sheetPdf(services, auth, id), 'Das Aufmaßblatt')
  })

  app.get('/api/v1/reports/:id/pdf', async (request, reply) => {
    const auth = requireAuth(request)
    const { id } = parse(documentParam, request.params)
    return sendPdf(reply, await reportPdf(services, auth, id), 'Der Bericht')
  })
}
