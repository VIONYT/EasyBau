export { toCii } from './cii.js'
export {
  type EinvoiceContext,
  type EinvoiceProblem,
  einvoiceFormatsOf,
  einvoiceFromDocument,
  einvoiceProblems,
  isEinvoiceDocument,
  isLeitwegId,
} from './document.js'
export {
  addFacturXMetadata,
  FACTURX_FILENAME,
  type FacturXConformance,
  FacturXError,
  facturXmp,
} from './facturx.js'
export { amount } from './format.js'
export {
  centsOf,
  einvoiceSyntaxOf,
  extractPdfEinvoice,
  type IncomingEinvoice,
  IncomingEinvoiceError,
  type IncomingLine,
  type IncomingParty,
  type IncomingProfile,
  type IncomingSyntax,
  type IncomingVatBreakdown,
  profileOf,
  readIncomingEinvoice,
} from './incoming.js'
export { parseKositReport, type ValidationMessage, type ValidationResult } from './kosit.js'
export * from './model.js'
export { toUbl } from './ubl.js'

import type { DocumentDetail, EinvoiceFormat } from '@easybau/schemas'
import { toCii } from './cii.js'
import { type EinvoiceContext, einvoiceFromDocument } from './document.js'
import { toUbl } from './ubl.js'

/** One e-invoice file of a document. */
export interface EinvoiceFile {
  format: EinvoiceFormat
  /** Download name, e.g. factur-x.xml or R2026-00101_xrechnung.xml */
  filename: string
  xml: string
}

/** Builds the XML of a finalized document in the given format. */
export function buildEinvoice(
  doc: DocumentDetail,
  ctx: EinvoiceContext,
  format: EinvoiceFormat,
): EinvoiceFile {
  const model = einvoiceFromDocument(doc, ctx, format)
  const safeNumber = model.number.replace(/[^A-Za-z0-9._-]+/g, '_')
  switch (format) {
    case 'zugferd':
      return { format, filename: 'factur-x.xml', xml: toCii(model, 'en16931') }
    case 'xrechnung_cii':
      return { format, filename: `${safeNumber}_xrechnung.xml`, xml: toCii(model, 'xrechnung') }
    case 'xrechnung_ubl':
      return { format, filename: `${safeNumber}_xrechnung.xml`, xml: toUbl(model) }
  }
}
