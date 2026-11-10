import type { Tx } from '@opc/db'
import {
  buildEinvoice,
  type EinvoiceContext,
  einvoiceFormatsOf,
  isEinvoiceDocument,
} from '@opc/einvoice'
import type { DocumentDetail, EinvoiceFormat, EinvoiceSummary } from '@opc/schemas'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { storeArtifact } from './artifacts.js'
import {
  type AuthContext,
  inTenant,
  requirePermission,
  type Services,
  servicesOf,
} from './context.js'
import { HttpError, notFound, parse } from './http.js'
import { ValidatorUnavailableError } from './kosit.js'
import { loadDocument } from './routes/documents.js'

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
export async function einvoiceSummary(tx: Tx, documentId: string): Promise<EinvoiceSummary | null> {
  const rows = await tx<
    { id: string; format: EinvoiceFormat; validatedAt: string; sizeBytes: string; sha256: string }[]
  >`
    select id, format, to_char(validated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "validatedAt",
           size_bytes::text as "sizeBytes", encode(sha256, 'hex') as sha256
    from document_artifact
    where document_id = ${documentId} and kind in ('zugferd_xml', 'xrechnung_xml')
    order by kind = 'zugferd_xml' desc, format, created_at`
  if (!rows.length) return null
  return {
    files: rows.map((r) => ({
      format: r.format,
      validatedAt: r.validatedAt,
      sizeBytes: Number(r.sizeBytes),
      sha256: r.sha256,
    })),
  }
}

const downloadParams = z.object({
  id: z.uuid('Ungültige ID.'),
  format: z.enum(['zugferd', 'xrechnung_ubl', 'xrechnung_cii'], 'Unbekanntes E-Rechnungsformat.'),
})

/** Download name: R2026-00101_zugferd.xml, R2026-00101_xrechnung.xml, …_pruefbericht.xml */
function downloadName(number: string, format: EinvoiceFormat, report: boolean): string {
  const safe = number.replace(/[^A-Za-z0-9._-]+/g, '_')
  const kind = format === 'zugferd' ? 'zugferd' : 'xrechnung'
  return `${safe}_${kind}${report ? '_pruefbericht' : ''}.xml`
}

export function registerEinvoiceRoutes(app: FastifyInstance, services: Services) {
  const serve = (report: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = requirePermission(request, 'document.read')
    const { id, format } = parse(downloadParams, request.params)
    const file = await inTenant(services, auth, async (tx) => {
      const doc = await loadDocument(tx, auth, id)
      if (!doc?.number) return null
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
      return key ? { key, name: downloadName(doc.number, format, report) } : null
    })
    if (!file) throw notFound(report ? 'Der Prüfbericht' : 'Die E-Rechnung')
    return reply
      .header('content-type', 'application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.name}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(services.storage.read(file.key))
  }
  // The archived original, byte for byte as validated by KoSIT (GoBD).
  app.get('/api/v1/documents/:id/einvoice/:format', serve(false))
  app.get('/api/v1/documents/:id/einvoice/:format/report', serve(true))
}
