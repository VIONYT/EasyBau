/**
 * ZUGFeRD 2.x / Factur-X needs, besides the attached factur-x.xml (written by Typst with
 * AFRelationship /Alternative), the Factur-X XMP extension schema in the document metadata. Typst
 * writes standard PDF/A-3b metadata only, so this appends an incremental update that replaces the
 * metadata stream object; all original bytes stay untouched (PDF/A permits incremental updates).
 */

export const FACTURX_FILENAME = 'factur-x.xml'
const FX_NAMESPACE = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#'

export type FacturXConformance = 'EN 16931' | 'XRECHNUNG'

const property = (name: string, description: string) =>
  `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${name}</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>${description}</pdfaProperty:description></rdf:li>`

const EXTENSION_SCHEMA =
  `<rdf:li rdf:parseType="Resource"><pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema><pdfaSchema:namespaceURI>${FX_NAMESPACE}</pdfaSchema:namespaceURI><pdfaSchema:prefix>fx</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq>` +
  property('DocumentFileName', 'The name of the embedded XML document') +
  property(
    'DocumentType',
    'The type of the hybrid document in capital letters, e.g. INVOICE or ORDER',
  ) +
  property('Version', 'The actual version of the standard applying to the embedded XML document') +
  property('ConformanceLevel', 'The conformance level of the embedded XML document') +
  '</rdf:Seq></pdfaSchema:property></rdf:li>'

export class FacturXError extends Error {
  override name = 'FacturXError'
}

/** Adds the Factur-X schema description and fx: properties to Typst's XMP packet. */
export function facturXmp(xmp: string, conformance: FacturXConformance): string {
  const bag = '<pdfaExtension:schemas><rdf:Bag>'
  if (!xmp.includes(bag) || !xmp.includes('</rdf:RDF>')) {
    throw new FacturXError('XMP metadata has an unexpected structure.')
  }
  const fx =
    `<rdf:Description rdf:about="" xmlns:fx="${FX_NAMESPACE}">` +
    `<fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>${FACTURX_FILENAME}</fx:DocumentFileName>` +
    `<fx:Version>1.0</fx:Version><fx:ConformanceLevel>${conformance}</fx:ConformanceLevel></rdf:Description>`
  return xmp.replace(bag, bag + EXTENSION_SCHEMA).replace('</rdf:RDF>', `${fx}</rdf:RDF>`)
}

const latin1 = (buffer: Buffer) => buffer.toString('latin1')

/**
 * Returns the PDF with an incremental update replacing the XMP metadata stream by one with the
 * Factur-X extension. Expects a classic cross-reference table as written by Typst.
 */
export function addFacturXMetadata(
  pdf: Buffer,
  conformance: FacturXConformance = 'EN 16931',
): Buffer {
  const text = latin1(pdf)
  const startxref = text.lastIndexOf('startxref')
  const trailerAt = text.lastIndexOf('trailer', startxref)
  if (startxref < 0 || trailerAt < 0) {
    throw new FacturXError('PDF without classic trailer (cross-reference stream not supported).')
  }
  const prev = Number(/startxref\s+(\d+)/.exec(text.slice(startxref))?.[1])
  const trailer = text.slice(trailerAt, startxref)
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)?.[1])
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(trailer)?.[1]
  const info = /\/Info\s+(\d+\s+\d+\s+R)/.exec(trailer)?.[1]
  const id = /\/ID\s*(\[[^\]]*\])/.exec(trailer)?.[1]
  if (!Number.isFinite(prev) || !size || !root || !id) {
    throw new FacturXError('PDF trailer incomplete.')
  }
  const rootNumber = root.split(/\s+/)[0]
  const catalogAt = text.search(new RegExp(`(^|\\n)${rootNumber} 0 obj`))
  const catalogEnd = text.indexOf('endobj', catalogAt)
  const metadataRef = /\/Metadata\s+(\d+)\s+0\s+R/.exec(text.slice(catalogAt, catalogEnd))?.[1]
  if (catalogAt < 0 || !metadataRef) throw new FacturXError('PDF catalog without metadata.')

  const begin = text.indexOf('<?xpacket begin')
  const endMarker = text.indexOf('<?xpacket end', begin)
  const end = text.indexOf('?>', endMarker)
  if (begin < 0 || endMarker < 0 || end < 0) throw new FacturXError('PDF without XMP packet.')
  // The packet is UTF-8; decode it from the original bytes.
  const xmp = pdf.subarray(begin, end + 2).toString('utf8')
  const updated = Buffer.from(facturXmp(xmp, conformance), 'utf8')

  const head = Buffer.from(
    `\n${metadataRef} 0 obj\n<<\n  /Length ${updated.length}\n  /Type /Metadata\n  /Subtype /XML\n>>\nstream\n`,
    'latin1',
  )
  const tail = Buffer.from('\nendstream\nendobj\n', 'latin1')
  const objectOffset = pdf.length + 1 // after the leading line break
  const xrefOffset = pdf.length + head.length + updated.length + tail.length
  const xref =
    `xref\n${metadataRef} 1\n${String(objectOffset).padStart(10, '0')} 00000 n \n` +
    `trailer\n<<\n  /Size ${size}\n  /Root ${root}\n${info ? `  /Info ${info}\n` : ''}  /ID ${id}\n  /Prev ${prev}\n>>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.concat([pdf, head, updated, tail, Buffer.from(xref, 'latin1')])
}
