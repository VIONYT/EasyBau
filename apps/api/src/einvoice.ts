import type { Tx } from '@easybau/db'
import {
  buildEinvoice,
  type EinvoiceContext,
  einvoiceFormatsOf,
  isEinvoiceDocument,
} from '@easybau/einvoice'
import type { DocumentDetail, EinvoiceFormat } from '@easybau/schemas'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { assertNotPurged, openArtifact, storeArtifact } from './artifacts.js'
import {
  type AuthContext,
  inTenant,
  requirePermission,
  type Services,
  servicesOf,
} from './context.js'
import { HttpError, notFound, parse } from './http.js'
import { ValidatorUnavailableError } from './kosit.js'
import { documentXmlFileName } from './routes/document-settings.js'
import { loadDocument } from './routes/documents.js'
import { contentDisposition } from './routes/pdf.js'

const FORMAT_LABEL: Record<EinvoiceFormat, string> = {
  zugferd: 'ZUGFeRD',
  xrechnung_ubl: 'XRechnung (UBL)',
  xrechnung_cii: 'XRechnung (CII)',
}

/** Units (UN/ECE codes) and the date of a cancelled invoice: what the XML needs beyond the document. */
export async function einvoiceContext(tx: Tx, doc: DocumentDetail): Promise<EinvoiceContext> {
  const units = await tx<{ id: string; code: string }[]>`select id, unece_code as code from unit`
  let cancelledInvoiceDate: string | null = null
  if (doc.cancels) {
    const [row] = await tx<{ date: string }[]>`
      select to_char(document_date, 'YYYY-MM-DD') as date from document where id = ${doc.cancels.id}`
    cancelledInvoiceDate = row?.date ?? null
  }
  return { unitCodes: new Map(units.map((u) => [u.id, u.code])), cancelledInvoiceDate }
}

/**
 * Issues the e-invoice of a just finalized invoice inside the finalize transaction (rule 8): builds
 * ZUGFeRD and, if wanted, XRechnung, validates each with KoSIT and archives XML and report. If a
 * file fails or KoSIT is unavailable the transaction is rolled back, so no number is consumed.
 */
export async function issueEinvoices(
  tx: Tx,
  doc: DocumentDetail,
  auth: AuthContext,
): Promise<void> {
  if (!isEinvoiceDocument(doc)) return
  const services = servicesOf(tx)
  if (!services) throw new Error('issueEinvoices requires inTenant()')
  const validator = services.einvoiceValidator
  if (!validator) {
    throw new HttpError(
      503,
      'Die E-Rechnungs-Prüfung (KoSIT) ist nicht eingerichtet. Rechnungen können erst festgeschrieben werden, wenn der Prüfdienst läuft (KOSIT_URL).',
    )
  }
  if (!doc.issuer.address || !doc.recipient?.address) {
    // Storno of an invoice finalized before e-invoicing: its snapshot has no structured address.
    if (doc.invoiceKind === 'cancellation') return
    throw new HttpError(409, 'Für die E-Rechnung fehlen die strukturierten Anschriften.')
  }
  const ctx = await einvoiceContext(tx, doc)
  const checked = []
  for (const format of einvoiceFormatsOf(doc.recipient)) {
    const file = buildEinvoice(doc, ctx, format)
    let validation: Awaited<ReturnType<typeof validator.validate>>
    try {
      validation = await validator.validate(file.xml)
    } catch (error) {
      if (!(error instanceof ValidatorUnavailableError)) throw error
      throw new HttpError(
        503,
        'Die E-Rechnungs-Prüfung (KoSIT) ist gerade nicht erreichbar. Die Rechnung wurde nicht festgeschrieben; bitte in einer Minute erneut versuchen.',
      )
    }
    if (!validation.valid) {
      const errors = validation.result.messages.filter((m) => m.level === 'error')
      const shown = (errors.length ? errors : validation.result.messages).slice(0, 8)
      throw new HttpError(
        422,
        `Die E-Rechnung (${FORMAT_LABEL[format]}) hat die Prüfung nicht bestanden. Die Rechnung wurde nicht festgeschrieben.`,
        {
          einvoice:
            shown.map((m) => `${m.code ? `${m.code}: ` : ''}${m.text}`).join(' · ') ||
            'Die Datei wurde vom Prüfdienst abgelehnt.',
        },
      )
    }
    checked.push({ file, validation })
  }
  for (const { file, validation } of checked) {
    const xmlId = await storeArtifact(tx, services, auth, doc.id, {
      kind: file.format === 'zugferd' ? 'zugferd_xml' : 'xrechnung_xml',
      data: Buffer.from(file.xml, 'utf8'),
      mime: 'application/xml',
      format: file.format,
      validated: true,
    })
    await storeArtifact(tx, services, auth, doc.id, {
      kind: 'validation_report',
      data: Buffer.from(validation.report, 'utf8'),
      mime: 'application/xml',
      format: file.format,
      sourceArtifactId: xmlId,
    })
  }
}

/** E-invoice files of a document for the detail view. */
const downloadParams = z.object({
  id: z.uuid('Ungültige ID.'),
  format: z.enum(['zugferd', 'xrechnung_ubl', 'xrechnung_cii'], 'Unbekanntes E-Rechnungsformat.'),
})

/** Download name after the Dateinamen-Muster: Rechnung_R2026-00101_XRechnung.xml, …_Pruefbericht.xml */
const downloadSuffix = (format: EinvoiceFormat, report: boolean) =>
  `${format === 'zugferd' ? 'ZUGFeRD' : 'XRechnung'}${report ? '_Pruefbericht' : ''}`

export function registerEinvoiceRoutes(app: FastifyInstance, services: Services) {
  const serve = (report: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = requirePermission(request, 'document.read')
    const { id, format } = parse(downloadParams, request.params)
    const file = await inTenant(services, auth, async (tx) => {
      const doc = await loadDocument(tx, auth, id)
      if (!doc?.number) return null
      await assertNotPurged(tx, id)
      const key = report
        ? (
            await tx<{ key: string }[]>`
              select r.storage_key as key from document_artifact x
              join document_artifact r on r.source_artifact_id = x.id and r.kind = 'validation_report'
              where x.document_id = ${id} and x.format = ${format}
                and x.kind in ('zugferd_xml', 'xrechnung_xml')
              order by r.created_at limit 1`
          )[0]?.key
        : (
            await tx<{ key: string }[]>`
              select storage_key as key from document_artifact
              where document_id = ${id} and format = ${format} and kind in ('zugferd_xml', 'xrechnung_xml')
              order by created_at limit 1`
          )[0]?.key
      return key
        ? { key, name: await documentXmlFileName(tx, doc, downloadSuffix(format, report)) }
        : null
    })
    if (!file) throw notFound(report ? 'Der Prüfbericht' : 'Die E-Rechnung')
    const original = await openArtifact(services, file.key)
    if (!original) throw notFound(report ? 'Der Prüfbericht' : 'Die E-Rechnung')
    return reply
      .header('content-type', 'application/xml; charset=utf-8')
      .header('content-disposition', contentDisposition(file.name).replace(/^inline/, 'attachment'))
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(original)
  }
  // The archived original, byte for byte as validated by KoSIT (GoBD).
  app.get('/api/v1/documents/:id/einvoice/:format', serve(false))
  app.get('/api/v1/documents/:id/einvoice/:format/report', serve(true))
}
