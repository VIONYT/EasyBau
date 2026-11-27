import { deflateSync } from 'node:zlib'
import { documentLetter, renderLetterPdf } from '@easybau/pdf-templates'
import { describe, expect, it } from 'vitest'
import { invoice, item, standardItems, UNIT_CODES } from './fixtures.test-support.js'
import {
  addFacturXMetadata,
  buildEinvoice,
  centsOf,
  einvoiceFromDocument,
  extractPdfEinvoice,
  IncomingEinvoiceError,
  profileOf,
  readIncomingEinvoice,
} from './index.js'
import { child, childrenOf, readXml, textAt, XmlReadError } from './xml-read.js'

const ctx = { unitCodes: UNIT_CODES, cancelledInvoiceDate: '2026-11-10' }

describe('XML reader for received e-invoices', () => {
  it('reads elements, attributes, text, CDATA, entities and ignores prefixes and comments', () => {
    const root = readXml(
      '﻿<?xml version="1.0"?>\n<!-- c --><a:Root xmlns:a="urn:x" b:k=\'v &amp; w\'>' +
        '<a:Name>Müller &amp; Söhne &#x41;&#66;</a:Name><Empty/><Data><![CDATA[<raw>]]></Data>' +
        '<?pi x?><Rep>1</Rep><Rep>2</Rep></a:Root>',
    )
    expect(root.name).toBe('Root')
    expect(root.attrs).toEqual({ a: 'urn:x', k: 'v & w' })
    expect(textAt(root, 'Name')).toBe('Müller & Söhne AB')
    expect(textAt(root, 'Empty')).toBeNull()
    expect(textAt(root, 'Data')).toBe('<raw>')
    expect(childrenOf(root, 'Rep').map((r) => r.text)).toEqual(['1', '2'])
    expect(child(root, 'Missing', 'Deeper')).toBeNull()
    expect(child(null, 'X')).toBeNull()
    expect(childrenOf(undefined, 'X')).toEqual([])
  })

  it.each([
    ['<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>', /DOCTYPE/],
    ['<x>&e;</x>', /Entität/],
    ['<x>&#0;</x>', /Entität/],
    ['<x><y></x>', /Endtag/],
    ['<x>', /nicht beendet/],
    ['<x/><y/>', /Wurzelelement/],
    ['text<x/>', /außerhalb/],
    ['<x/>tail', /außerhalb/],
    ['', /Kein XML/],
    ['<x><!-- open</x>', /Kommentar/],
    ['<x><![CDATA[open</x>', /CDATA/],
    ['<?xml version="1.0"', /Verarbeitungsanweisung/],
    ['<x></x', /Endtag nicht beendet/],
    ['< x/>', /Starttag/],
    ['<x a="1" b>', /Starttag/],
  ])('rejects %s', (xml, message) => {
    expect(() => readXml(xml)).toThrow(XmlReadError)
    expect(() => readXml(xml)).toThrow(message)
  })

  it('limits depth and element count', () => {
    expect(() => readXml('<a><a><a></a></a></a>', { maxDepth: 2 })).toThrow(/verschachtelt/)
    expect(() => readXml('<a><b/><b/><b/></a>', { maxElements: 3 })).toThrow(/zu groß/)
  })
})

describe('Profiles and amounts', () => {
  it.each([
    [
      'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
      'XRechnung 3.0',
      true,
    ],
    ['urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung', 'XRechnung', true],
    ['urn:factur-x.eu:1p0:minimum', 'ZUGFeRD MINIMUM', false],
    ['urn:factur-x.eu:1p0:basicwl', 'ZUGFeRD BASIC WL', false],
    ['urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic', 'ZUGFeRD BASIC', true],
    ['urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended', 'ZUGFeRD EXTENDED', true],
    [
      'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
      'Peppol BIS Billing',
      true,
    ],
    ['urn:cen.eu:en16931:2017', 'EN 16931', true],
    ['urn:example', 'unbekanntes Profil', false],
    [null, 'ohne Profilangabe', false],
  ])('%s → %s', (spec, label, en16931) => {
    expect(profileOf(spec)).toEqual({ label, en16931 })
  })

  it('converts decimal amounts to cents, half up', () => {
    expect(centsOf('1234.565')).toBe(123457n)
    expect(centsOf('-0.005')).toBe(-1n)
    expect(centsOf(' 12 ')).toBe(1200n)
    expect(centsOf('1,50')).toBeNull()
    expect(centsOf('')).toBeNull()
    expect(centsOf(null)).toBeNull()
  })
})

describe('Reading received e-invoices', () => {
  const doc = invoice(standardItems(), { number: 'R2026-00042' })

  it.each([
    ['zugferd', 'cii', 'EN 16931'],
    ['xrechnung_cii', 'cii', 'XRechnung 3.0'],
    ['xrechnung_ubl', 'ubl', 'XRechnung 3.0'],
  ] as const)('reads %s (%s) like the model it was written from', (format, syntax, label) => {
    const model = einvoiceFromDocument(doc, ctx, format)
    const read = readIncomingEinvoice(buildEinvoice(doc, ctx, format).xml)
    expect(read).toMatchObject({
      syntax,
      documentKind: 'invoice',
      profile: { label, en16931: true },
      number: 'R2026-00042',
      typeCode: model.typeCode,
      issueDate: model.issueDate,
      dueDate: model.dueDate,
      currency: 'EUR',
      buyerReference: model.buyerReference,
      notes: model.notes,
    })
    expect(read.seller).toMatchObject({
      name: model.seller.name,
      vatId: model.seller.vatId,
      postalCode: model.seller.address.postalCode,
      city: model.seller.address.city,
      street: model.seller.address.street,
      countryCode: 'DE',
    })
    expect(read.buyer.name).toBe(model.buyer.name)
    expect(read.payment).toMatchObject({
      iban: model.payment.iban,
      reference: model.payment.reference,
    })
    expect(read.lines.map((l) => [l.name, l.netCents, l.vatCategory, l.vatRate])).toEqual(
      model.lines.map((l) => [l.name, l.netCents, l.vatCategory, String(Number(l.vatRate))]),
    )
    expect(read.lines[0]).toMatchObject({ quantity: '186.4', unitCode: 'MTK', netPrice: '12.5' })
    expect(read.vatBreakdown).toEqual(
      model.vatBreakdown.map((v) => ({
        category: v.category,
        rate: String(Number(v.rate)),
        baseCents: v.baseCents,
        taxCents: v.taxCents,
        exemptionReason: v.exemptionReason,
      })),
    )
    expect(read.totals).toMatchObject({
      lineNetCents: model.totals.lineNetCents,
      netCents: model.totals.netCents,
      taxCents: model.totals.taxCents,
      grossCents: model.totals.grossCents,
      dueCents: model.totals.dueCents,
    })
  })

  it.each(['zugferd', 'xrechnung_ubl'] as const)(
    'reads document-level allowances with their VAT rate (%s)',
    (format) => {
      const discounted = invoice(standardItems(), { number: 'R2026-00043', discountPercent: '3' })
      const model = einvoiceFromDocument(discounted, ctx, format)
      expect(model.allowancesCharges.length).toBeGreaterThan(0)
      const read = readIncomingEinvoice(buildEinvoice(discounted, ctx, format).xml)
      expect(read.allowanceCharges).toEqual(
        model.allowancesCharges.map((a) => ({
          charge: a.charge,
          amountCents: a.amountCents,
          reason: a.reason,
          vatCategory: a.vatCategory,
          vatRate: String(Number(a.vatRate)),
        })),
      )
      expect(readIncomingEinvoice(buildEinvoice(doc, ctx, format).xml).allowanceCharges).toEqual([])
    },
  )

  it('reads a UBL credit note and a CII Storno as credit note / reverse charge as AE', () => {
    const credit = invoice(
      [item({ oz: '1', text: 'Gutschrift', quantity: '1', unit: 'stk', priceCents: 10000 })],
      {
        type: 'credit_note',
      },
    )
    const ubl = readIncomingEinvoice(buildEinvoice(credit, ctx, 'xrechnung_ubl').xml)
    expect(ubl.documentKind).toBe('credit_note')
    expect(ubl.lines).toHaveLength(1)
    expect(ubl.lines[0]?.quantity).toBe('1')
    const cii = readIncomingEinvoice(buildEinvoice(credit, ctx, 'zugferd').xml)
    expect(cii.documentKind).toBe('credit_note')

    const reverse = invoice(standardItems(), { taxMode: 'reverse_charge_13b' })
    const read = readIncomingEinvoice(buildEinvoice(reverse, ctx, 'zugferd').xml)
    expect(read.vatBreakdown.map((v) => [v.category, v.taxCents])).toEqual([['AE', 0n]])
    expect(read.totals.taxCents).toBe(0n)
  })

  it('accepts sparse invoices from other senders', () => {
    const read = readIncomingEinvoice(
      `<rsm:CrossIndustryInvoice xmlns:rsm="r" xmlns:ram="a" xmlns:udt="u">
        <rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter>
          <ram:ID>urn:factur-x.eu:1p0:minimum</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
        </rsm:ExchangedDocumentContext>
        <rsm:ExchangedDocument><ram:ID>4711</ram:ID><ram:TypeCode>380</ram:TypeCode>
          <ram:IssueDateTime><udt:DateTimeString format="102">20261105</udt:DateTimeString></ram:IssueDateTime>
        </rsm:ExchangedDocument>
        <rsm:SupplyChainTradeTransaction>
          <ram:ApplicableHeaderTradeAgreement>
            <ram:SellerTradeParty><ram:Name>Baustoff Nord GmbH</ram:Name>
              <ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">12/345/67890</ram:ID></ram:SpecifiedTaxRegistration>
            </ram:SellerTradeParty>
          </ram:ApplicableHeaderTradeAgreement>
          <ram:ApplicableHeaderTradeDelivery/>
          <ram:ApplicableHeaderTradeSettlement>
            <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
            <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
              <ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount>
              <ram:TaxTotalAmount currencyID="USD">21.00</ram:TaxTotalAmount>
              <ram:TaxTotalAmount currencyID="EUR">19.00</ram:TaxTotalAmount>
              <ram:GrandTotalAmount>119.00</ram:GrandTotalAmount>
              <ram:DuePayableAmount>119.00</ram:DuePayableAmount>
            </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
          </ram:ApplicableHeaderTradeSettlement>
        </rsm:SupplyChainTradeTransaction>
      </rsm:CrossIndustryInvoice>`,
    )
    expect(read).toMatchObject({
      profile: { label: 'ZUGFeRD MINIMUM', en16931: false },
      number: '4711',
      issueDate: '2026-11-05',
      dueDate: null,
      period: null,
      lines: [],
      vatBreakdown: [],
      seller: { name: 'Baustoff Nord GmbH', taxNumber: '12/345/67890', vatId: null },
      totals: { netCents: 10000n, taxCents: 1900n, grossCents: 11900n, lineNetCents: null },
    })
  })

  it('reads a sparse UBL invoice with a second tax total and an ISO date time', () => {
    const read = readIncomingEinvoice(
      `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
        <ID>A-1</ID><IssueDate>2026-11-05T00:00:00</IssueDate><InvoiceTypeCode>381</InvoiceTypeCode>
        <Note>  </Note><InvoicePeriod><StartDate>2026-10-01</StartDate></InvoicePeriod>
        <TaxTotal><TaxAmount>1.00</TaxAmount></TaxTotal>
        <TaxTotal><TaxAmount>19.00</TaxAmount><TaxSubtotal><TaxableAmount>100</TaxableAmount>
          <TaxAmount>19</TaxAmount><TaxCategory><ID>S</ID><Percent>19.00</Percent></TaxCategory></TaxSubtotal>
        </TaxTotal>
        <PaymentMeans><PaymentDueDate>2026-12-05</PaymentDueDate></PaymentMeans>
      </Invoice>`,
    )
    expect(read).toMatchObject({
      documentKind: 'credit_note',
      issueDate: '2026-11-05',
      dueDate: '2026-12-05',
      notes: [],
      period: { start: '2026-10-01', end: null },
      vatBreakdown: [{ category: 'S', rate: '19', baseCents: 10000n, taxCents: 1900n }],
      totals: { taxCents: 1900n, grossCents: null },
      profile: { label: 'ohne Profilangabe', en16931: false },
    })
  })

  it('rejects other XML and broken XML', () => {
    expect(() => readIncomingEinvoice('<Order/>')).toThrow(IncomingEinvoiceError)
    expect(() => readIncomingEinvoice('<Invoice>')).toThrow(/nicht lesbar/)
  })
})

/** A minimal PDF with one embedded file (as other producers write it). */
function pdfWith(dict: string, data: Buffer, extra = ''): Buffer {
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Type /Filespec /F (zugferd-invoice.xml) >> endobj\n${extra}3 0 obj << ${dict} /Length ${data.length} >>\nstream\r\n`,
      'latin1',
    ),
    data,
    Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ])
}

describe('ZUGFeRD: XML embedded in the PDF', () => {
  const doc = invoice(standardItems(), { number: 'R2026-00043' })
  const xml = buildEinvoice(doc, ctx, 'zugferd').xml

  it('finds factur-x.xml in a PDF/A-3 written by Typst', () => {
    const { logoPosition: _, ...letter } = documentLetter(doc, { watermark: null })
    const pdf = addFacturXMetadata(
      renderLetterPdf({ ...letter, logo: null }, { einvoiceXml: Buffer.from(xml) }),
      'EN 16931',
    )
    expect(extractPdfEinvoice(pdf)).toEqual({ filename: 'factur-x.xml', xml })
  })

  it('reads compressed and uncompressed embedded files of other producers', () => {
    const flate = pdfWith(
      '/Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode /Params << /Size 9 >>',
      deflateSync(Buffer.from(xml)),
    )
    expect(extractPdfEinvoice(flate)).toEqual({ filename: 'zugferd-invoice.xml', xml })
    const plain = pdfWith('/Subtype /application#2Fxml', Buffer.from(xml))
    expect(extractPdfEinvoice(plain)?.xml).toBe(xml)
    // Length as indirect reference: up to endstream.
    const indirect = Buffer.from(
      pdfWith('/Type /EmbeddedFile', Buffer.from(xml))
        .toString('latin1')
        .replace(/\/Length \d+/, '/Length 9 0 R'),
      'latin1',
    )
    expect(extractPdfEinvoice(indirect)?.xml).toBe(`${xml}\n`)
  })

  it('scans crafted PDFs in linear time (many objects without streams)', () => {
    const shapes = [
      `%PDF-1.4\n${'9 0 obj\nnull\nendobj\n'.repeat(120_000)}`,
      `%PDF-1.4\n${'9 0 obj\n'.repeat(250_000)}stream\n`,
      `%PDF-1.4\n${'9 0 obj\n<< >>\nstream\n'.repeat(100_000)}`,
    ]
    for (const shape of shapes) {
      const started = performance.now()
      expect(extractPdfEinvoice(Buffer.from(shape, 'latin1'))).toBeNull()
      expect(performance.now() - started).toBeLessThan(1500)
    }
    // An embedded invoice after many empty objects is still found.
    const padded = Buffer.concat([
      Buffer.from(`%PDF-1.7\n${'8 0 obj\nnull\nendobj\n'.repeat(10_000)}`, 'latin1'),
      pdfWith('/Type /EmbeddedFile', Buffer.from(xml)).subarray(9),
    ])
    expect(extractPdfEinvoice(padded)?.xml).toBe(xml)
  })

  it('returns null for PDFs without e-invoice, encrypted, broken or other files', () => {
    expect(extractPdfEinvoice(Buffer.from('not a pdf'))).toBeNull()
    expect(
      extractPdfEinvoice(pdfWith('/Type /EmbeddedFile /Encrypt 5 0 R', Buffer.from(xml))),
    ).toBeNull()
    expect(extractPdfEinvoice(pdfWith('/Type /XObject', Buffer.from(xml)))).toBeNull()
    expect(extractPdfEinvoice(pdfWith('/Type /EmbeddedFile', Buffer.from('<Order/>')))).toBeNull()
    expect(
      extractPdfEinvoice(pdfWith('/Type /EmbeddedFile /Filter /FlateDecode', Buffer.from('xx'))),
    ).toBeNull()
    expect(
      extractPdfEinvoice(pdfWith('/Type /EmbeddedFile /Filter /DCTDecode', Buffer.from(xml))),
    ).toBeNull()
    // Object without stream before the embedded file, and a stream that claims too much.
    expect(
      extractPdfEinvoice(
        pdfWith('/Type /EmbeddedFile', Buffer.from(xml), '4 0 obj << /A 1 >> endobj\n'),
      )?.xml,
    ).toBe(xml)
    expect(
      extractPdfEinvoice(
        Buffer.from(
          `%PDF-1.7\n3 0 obj << /Type /EmbeddedFile /Length 99999 >>\nstream\n${xml}`,
          'latin1',
        ),
      ),
    ).toBeNull()
  })
})
