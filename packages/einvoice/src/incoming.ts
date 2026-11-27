import { inflateSync } from 'node:zlib'
import { Decimal } from 'decimal.js'
import { child, childrenOf, readXml, textAt, type XmlElement, XmlReadError } from './xml-read.js'

/**
 * Received e-invoices (Eingangsrechnungen, P1.11): reads ZUGFeRD/Factur-X and XRechnung in both
 * syntaxes (UN/CEFACT CII and UBL Invoice/CreditNote) into a lenient model for display and for
 * prefilling the review form. Amounts are cents, everything optional the sender may have left out
 * is null. Nothing is evaluated; the XML reader rejects DTDs and entities.
 */

export type IncomingSyntax = 'cii' | 'ubl'

export interface IncomingParty {
  name: string | null
  /** BT-29 / BT-46 identifier (e.g. Lieferantennummer, Kundennummer). */
  id: string | null
  vatId: string | null
  taxNumber: string | null
  street: string | null
  streetExtra: string | null
  postalCode: string | null
  city: string | null
  countryCode: string | null
  email: string | null
  electronicAddress: string | null
}

export interface IncomingLine {
  id: string | null
  name: string | null
  description: string | null
  quantity: string | null
  unitCode: string | null
  netPrice: string | null
  netCents: bigint | null
  vatCategory: string | null
  vatRate: string | null
}

/** Document-level allowance (BG-20) or charge (BG-21). */
export interface IncomingAllowanceCharge {
  charge: boolean
  amountCents: bigint | null
  reason: string | null
  vatCategory: string | null
  vatRate: string | null
}

export interface IncomingVatBreakdown {
  category: string | null
  rate: string | null
  baseCents: bigint | null
  taxCents: bigint | null
  exemptionReason: string | null
}

export interface IncomingEinvoice {
  syntax: IncomingSyntax
  /** Credit notes (381 and UBL CreditNote) carry positive amounts that reduce the debt. */
  documentKind: 'invoice' | 'credit_note'
  /** BT-24, e.g. urn:cen.eu:en16931:2017 */
  specification: string | null
  profile: IncomingProfile
  number: string | null
  typeCode: string | null
  issueDate: string | null
  dueDate: string | null
  currency: string | null
  buyerReference: string | null
  orderReference: string | null
  notes: string[]
  period: { start: string | null; end: string | null } | null
  deliveryDate: string | null
  seller: IncomingParty
  buyer: IncomingParty
  payment: {
    meansCode: string | null
    reference: string | null
    iban: string | null
    bic: string | null
    accountName: string | null
    terms: string | null
  }
  lines: IncomingLine[]
  /** Allowances and charges on document level (not those of single lines). */
  allowanceCharges: IncomingAllowanceCharge[]
  vatBreakdown: IncomingVatBreakdown[]
  totals: {
    lineNetCents: bigint | null
    allowanceCents: bigint | null
    chargeCents: bigint | null
    netCents: bigint | null
    taxCents: bigint | null
    grossCents: bigint | null
    prepaidCents: bigint | null
    dueCents: bigint | null
  }
}

export interface IncomingProfile {
  /** Short name for the UI, e.g. "XRechnung 3.0", "ZUGFeRD EN 16931", "ZUGFeRD MINIMUM". */
  label: string
  /**
   * Structured invoice per EN 16931 (§ 14 UStG since 2025). MINIMUM and BASIC WL are only
   * booking aids, not e-invoices.
   */
  en16931: boolean
}

export class IncomingEinvoiceError extends Error {
  override name = 'IncomingEinvoiceError'
}

const CREDIT_NOTE_CODES = new Set(['381', '261', '396', '532'])

/** Profile from BT-24 (Factur-X/ZUGFeRD levels, XRechnung, Peppol). */
export function profileOf(specification: string | null): IncomingProfile {
  const spec = (specification ?? '').toLowerCase()
  if (spec.includes('xrechnung')) {
    const version = /xrechnung_(\d+\.\d+)/.exec(spec)?.[1]
    return { label: version ? `XRechnung ${version}` : 'XRechnung', en16931: true }
  }
  if (spec.includes('factur-x.eu:1p0:minimum') || spec.includes('zugferd.de:2p0:minimum')) {
    return { label: 'ZUGFeRD MINIMUM', en16931: false }
  }
  if (spec.includes('basicwl')) return { label: 'ZUGFeRD BASIC WL', en16931: false }
  if (spec.includes(':basic')) return { label: 'ZUGFeRD BASIC', en16931: true }
  if (spec.includes(':extended')) return { label: 'ZUGFeRD EXTENDED', en16931: true }
  if (spec.includes('peppol')) return { label: 'Peppol BIS Billing', en16931: true }
  if (spec.startsWith('urn:cen.eu:en16931:2017')) return { label: 'EN 16931', en16931: true }
  return { label: specification ? 'unbekanntes Profil' : 'ohne Profilangabe', en16931: false }
}

const AMOUNT = /^[+-]?\d+(\.\d+)?$/

/** Decimal amount (any number of decimals) → cents, rounded half up; null if missing/invalid. */
export function centsOf(value: string | null | undefined): bigint | null {
  const text = value?.trim()
  if (!text || !AMOUNT.test(text)) return null
  return BigInt(new Decimal(text).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0))
}

const decimalText = (value: string | null): string | null =>
  value && AMOUNT.test(value) ? new Decimal(value).toString() : null

/** CII date (format 102 = YYYYMMDD) or ISO date → YYYY-MM-DD. */
function isoDate(value: string | null): string | null {
  if (!value) return null
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  return iso ? (iso[1] as string) : null
}

// ---------------------------------------------------------------------------------------------
// CII (ZUGFeRD/Factur-X, XRechnung CII)
// ---------------------------------------------------------------------------------------------

function ciiParty(party: XmlElement | null): IncomingParty {
  const address = child(party, 'PostalTradeAddress')
  const registrations = childrenOf(party, 'SpecifiedTaxRegistration')
  const registration = (scheme: string) =>
    registrations
      .map((r) => child(r, 'ID'))
      .find((id) => id?.attrs.schemeID === scheme)
      ?.text.trim() || null
  return {
    name: textAt(party, 'Name'),
    id: textAt(party, 'ID') ?? textAt(party, 'GlobalID'),
    vatId: registration('VA'),
    taxNumber: registration('FC'),
    street: textAt(address, 'LineOne'),
    streetExtra: textAt(address, 'LineTwo'),
    postalCode: textAt(address, 'PostcodeCode'),
    city: textAt(address, 'CityName'),
    countryCode: textAt(address, 'CountryID'),
    email: textAt(party, 'DefinedTradeContact', 'EmailURIUniversalCommunication', 'URIID'),
    electronicAddress: textAt(party, 'URIUniversalCommunication', 'URIID'),
  }
}

/** Amount in the invoice currency (BT-111 may repeat TaxTotalAmount in the accounting currency). */
function ciiAmount(
  parent: XmlElement | null,
  name: string,
  currency: string | null,
): bigint | null {
  const all = childrenOf(parent, name)
  const match = all.find((a) => !a.attrs.currencyID || a.attrs.currencyID === currency) ?? all[0]
  return centsOf(match?.text)
}

function readCii(root: XmlElement): IncomingEinvoice {
  const doc = child(root, 'ExchangedDocument')
  const transaction = child(root, 'SupplyChainTradeTransaction')
  const agreement = child(transaction, 'ApplicableHeaderTradeAgreement')
  const delivery = child(transaction, 'ApplicableHeaderTradeDelivery')
  const settlement = child(transaction, 'ApplicableHeaderTradeSettlement')
  const summation = child(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation')
  const means = child(settlement, 'SpecifiedTradeSettlementPaymentMeans')
  const terms = child(settlement, 'SpecifiedTradePaymentTerms')
  const period = child(settlement, 'BillingSpecifiedPeriod')
  const currency = textAt(settlement, 'InvoiceCurrencyCode')
  const specification = textAt(
    root,
    'ExchangedDocumentContext',
    'GuidelineSpecifiedDocumentContextParameter',
    'ID',
  )
  const typeCode = textAt(doc, 'TypeCode')
  return {
    syntax: 'cii',
    documentKind: typeCode && CREDIT_NOTE_CODES.has(typeCode) ? 'credit_note' : 'invoice',
    specification,
    profile: profileOf(specification),
    number: textAt(doc, 'ID'),
    typeCode,
    issueDate: isoDate(textAt(doc, 'IssueDateTime', 'DateTimeString')),
    dueDate: isoDate(textAt(terms, 'DueDateDateTime', 'DateTimeString')),
    currency,
    buyerReference: textAt(agreement, 'BuyerReference'),
    orderReference: textAt(agreement, 'BuyerOrderReferencedDocument', 'IssuerAssignedID'),
    notes: childrenOf(doc, 'IncludedNote')
      .map((n) => textAt(n, 'Content'))
      .filter((n): n is string => n !== null),
    period: period
      ? {
          start: isoDate(textAt(period, 'StartDateTime', 'DateTimeString')),
          end: isoDate(textAt(period, 'EndDateTime', 'DateTimeString')),
        }
      : null,
    deliveryDate: isoDate(
      textAt(delivery, 'ActualDeliverySupplyChainEvent', 'OccurrenceDateTime', 'DateTimeString'),
    ),
    seller: ciiParty(child(agreement, 'SellerTradeParty')),
    buyer: ciiParty(child(agreement, 'BuyerTradeParty')),
    payment: {
      meansCode: textAt(means, 'TypeCode'),
      reference: textAt(settlement, 'PaymentReference'),
      iban:
        textAt(means, 'PayeePartyCreditorFinancialAccount', 'IBANID') ??
        textAt(means, 'PayeePartyCreditorFinancialAccount', 'ProprietaryID'),
      bic: textAt(means, 'PayeeSpecifiedCreditorFinancialInstitution', 'BICID'),
      accountName: textAt(means, 'PayeePartyCreditorFinancialAccount', 'AccountName'),
      terms: textAt(terms, 'Description'),
    },
    lines: childrenOf(transaction, 'IncludedSupplyChainTradeLineItem').map((line) => {
      const product = child(line, 'SpecifiedTradeProduct')
      const lineSettlement = child(line, 'SpecifiedLineTradeSettlement')
      const quantity = child(line, 'SpecifiedLineTradeDelivery', 'BilledQuantity')
      return {
        id: textAt(line, 'AssociatedDocumentLineDocument', 'LineID'),
        name: textAt(product, 'Name'),
        description: textAt(product, 'Description'),
        quantity: decimalText(quantity?.text.trim() ?? null),
        unitCode: quantity?.attrs.unitCode ?? null,
        netPrice: decimalText(
          textAt(line, 'SpecifiedLineTradeAgreement', 'NetPriceProductTradePrice', 'ChargeAmount'),
        ),
        netCents: centsOf(
          textAt(
            lineSettlement,
            'SpecifiedTradeSettlementLineMonetarySummation',
            'LineTotalAmount',
          ),
        ),
        vatCategory: textAt(lineSettlement, 'ApplicableTradeTax', 'CategoryCode'),
        vatRate: decimalText(textAt(lineSettlement, 'ApplicableTradeTax', 'RateApplicablePercent')),
      }
    }),
    allowanceCharges: childrenOf(settlement, 'SpecifiedTradeAllowanceCharge').map((item) => ({
      charge: textAt(item, 'ChargeIndicator', 'Indicator')?.toLowerCase() === 'true',
      amountCents: centsOf(textAt(item, 'ActualAmount')),
      reason: textAt(item, 'Reason'),
      vatCategory: textAt(item, 'CategoryTradeTax', 'CategoryCode'),
      vatRate: decimalText(textAt(item, 'CategoryTradeTax', 'RateApplicablePercent')),
    })),
    vatBreakdown: childrenOf(settlement, 'ApplicableTradeTax').map((tax) => ({
      category: textAt(tax, 'CategoryCode'),
      rate: decimalText(textAt(tax, 'RateApplicablePercent')),
      baseCents: centsOf(textAt(tax, 'BasisAmount')),
      taxCents: centsOf(textAt(tax, 'CalculatedAmount')),
      exemptionReason: textAt(tax, 'ExemptionReason'),
    })),
    totals: {
      lineNetCents: ciiAmount(summation, 'LineTotalAmount', currency),
      allowanceCents: ciiAmount(summation, 'AllowanceTotalAmount', currency),
      chargeCents: ciiAmount(summation, 'ChargeTotalAmount', currency),
      netCents: ciiAmount(summation, 'TaxBasisTotalAmount', currency),
      taxCents: ciiAmount(summation, 'TaxTotalAmount', currency),
      grossCents: ciiAmount(summation, 'GrandTotalAmount', currency),
      prepaidCents: ciiAmount(summation, 'TotalPrepaidAmount', currency),
      dueCents: ciiAmount(summation, 'DuePayableAmount', currency),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// UBL (XRechnung UBL, Peppol): Invoice and CreditNote
// ---------------------------------------------------------------------------------------------

function ublParty(wrapper: XmlElement | null): IncomingParty {
  const party = child(wrapper, 'Party')
  const address = child(party, 'PostalAddress')
  const schemes = childrenOf(party, 'PartyTaxScheme')
  const vat = schemes.find((s) => textAt(s, 'TaxScheme', 'ID') === 'VAT')
  const other = schemes.find((s) => textAt(s, 'TaxScheme', 'ID') !== 'VAT')
  return {
    name:
      textAt(party, 'PartyName', 'Name') ?? textAt(party, 'PartyLegalEntity', 'RegistrationName'),
    id: textAt(party, 'PartyIdentification', 'ID'),
    vatId: textAt(vat, 'CompanyID'),
    taxNumber: textAt(other, 'CompanyID'),
    street: textAt(address, 'StreetName'),
    streetExtra: textAt(address, 'AdditionalStreetName'),
    postalCode: textAt(address, 'PostalZone'),
    city: textAt(address, 'CityName'),
    countryCode: textAt(address, 'Country', 'IdentificationCode'),
    email: textAt(party, 'Contact', 'ElectronicMail'),
    electronicAddress: textAt(party, 'EndpointID'),
  }
}

function readUbl(root: XmlElement): IncomingEinvoice {
  const creditNote = root.name === 'CreditNote'
  const totals = child(root, 'LegalMonetaryTotal')
  const means = child(root, 'PaymentMeans')
  const period = child(root, 'InvoicePeriod')
  // The first TaxTotal carries the breakdown in the document currency (a second one may hold
  // the tax in the accounting currency, BT-111).
  const taxTotal = childrenOf(root, 'TaxTotal').find((t) => childrenOf(t, 'TaxSubtotal').length)
  const typeCode = textAt(root, creditNote ? 'CreditNoteTypeCode' : 'InvoiceTypeCode')
  const specification = textAt(root, 'CustomizationID')
  const lineName = creditNote ? 'CreditNoteLine' : 'InvoiceLine'
  const quantityName = creditNote ? 'CreditedQuantity' : 'InvoicedQuantity'
  return {
    syntax: 'ubl',
    documentKind:
      creditNote || (typeCode !== null && CREDIT_NOTE_CODES.has(typeCode))
        ? 'credit_note'
        : 'invoice',
    specification,
    profile: profileOf(specification),
    number: textAt(root, 'ID'),
    typeCode,
    issueDate: isoDate(textAt(root, 'IssueDate')),
    dueDate: isoDate(textAt(root, 'DueDate') ?? textAt(means, 'PaymentDueDate')),
    currency: textAt(root, 'DocumentCurrencyCode'),
    buyerReference: textAt(root, 'BuyerReference'),
    orderReference: textAt(root, 'OrderReference', 'ID'),
    notes: childrenOf(root, 'Note')
      .map((n) => n.text.trim())
      .filter(Boolean),
    period: period
      ? { start: isoDate(textAt(period, 'StartDate')), end: isoDate(textAt(period, 'EndDate')) }
      : null,
    deliveryDate: isoDate(textAt(root, 'Delivery', 'ActualDeliveryDate')),
    seller: ublParty(child(root, 'AccountingSupplierParty')),
    buyer: ublParty(child(root, 'AccountingCustomerParty')),
    payment: {
      meansCode: textAt(means, 'PaymentMeansCode'),
      reference: textAt(means, 'PaymentID'),
      iban: textAt(means, 'PayeeFinancialAccount', 'ID'),
      bic: textAt(means, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID'),
      accountName: textAt(means, 'PayeeFinancialAccount', 'Name'),
      terms: textAt(root, 'PaymentTerms', 'Note'),
    },
    lines: childrenOf(root, lineName).map((line) => {
      const item = child(line, 'Item')
      const quantity = child(line, quantityName)
      return {
        id: textAt(line, 'ID'),
        name: textAt(item, 'Name'),
        description: textAt(item, 'Description'),
        quantity: decimalText(quantity?.text.trim() ?? null),
        unitCode: quantity?.attrs.unitCode ?? null,
        netPrice: decimalText(textAt(line, 'Price', 'PriceAmount')),
        netCents: centsOf(textAt(line, 'LineExtensionAmount')),
        vatCategory: textAt(item, 'ClassifiedTaxCategory', 'ID'),
        vatRate: decimalText(textAt(item, 'ClassifiedTaxCategory', 'Percent')),
      }
    }),
    allowanceCharges: childrenOf(root, 'AllowanceCharge').map((item) => ({
      charge: textAt(item, 'ChargeIndicator')?.toLowerCase() === 'true',
      amountCents: centsOf(textAt(item, 'Amount')),
      reason: textAt(item, 'AllowanceChargeReason'),
      vatCategory: textAt(item, 'TaxCategory', 'ID'),
      vatRate: decimalText(textAt(item, 'TaxCategory', 'Percent')),
    })),
    vatBreakdown: childrenOf(taxTotal, 'TaxSubtotal').map((sub) => ({
      category: textAt(sub, 'TaxCategory', 'ID'),
      rate: decimalText(textAt(sub, 'TaxCategory', 'Percent')),
      baseCents: centsOf(textAt(sub, 'TaxableAmount')),
      taxCents: centsOf(textAt(sub, 'TaxAmount')),
      exemptionReason: textAt(sub, 'TaxCategory', 'TaxExemptionReason'),
    })),
    totals: {
      lineNetCents: centsOf(textAt(totals, 'LineExtensionAmount')),
      allowanceCents: centsOf(textAt(totals, 'AllowanceTotalAmount')),
      chargeCents: centsOf(textAt(totals, 'ChargeTotalAmount')),
      netCents: centsOf(textAt(totals, 'TaxExclusiveAmount')),
      taxCents: centsOf(textAt(taxTotal, 'TaxAmount')),
      grossCents: centsOf(textAt(totals, 'TaxInclusiveAmount')),
      prepaidCents: centsOf(textAt(totals, 'PrepaidAmount')),
      dueCents: centsOf(textAt(totals, 'PayableAmount')),
    },
  }
}

/** Syntax of an e-invoice root element, null for any other XML. */
export function einvoiceSyntaxOf(root: XmlElement): IncomingSyntax | null {
  if (root.name === 'CrossIndustryInvoice') return 'cii'
  if (root.name === 'Invoice' || root.name === 'CreditNote') return 'ubl'
  return null
}

/** Reads a received e-invoice (CII or UBL). Throws IncomingEinvoiceError for anything else. */
export function readIncomingEinvoice(xml: string): IncomingEinvoice {
  let root: XmlElement
  try {
    root = readXml(xml)
  } catch (error) {
    if (error instanceof XmlReadError) {
      throw new IncomingEinvoiceError(`Die XML-Datei ist nicht lesbar: ${error.message}`)
    }
    throw error
  }
  const syntax = einvoiceSyntaxOf(root)
  if (!syntax) {
    throw new IncomingEinvoiceError(
      'Die XML-Datei ist keine E-Rechnung (erwartet ZUGFeRD/Factur-X oder XRechnung in CII oder UBL).',
    )
  }
  return syntax === 'cii' ? readCii(root) : readUbl(root)
}

// ---------------------------------------------------------------------------------------------
// ZUGFeRD/Factur-X: the XML embedded in the PDF/A-3
// ---------------------------------------------------------------------------------------------

const MAX_XML_BYTES = 10 * 1024 * 1024
const KNOWN_NAMES = ['factur-x.xml', 'zugferd-invoice.xml', 'xrechnung.xml', 'zugferd_invoice.xml']

function looksLikeEinvoice(xml: string): boolean {
  const head = xml.slice(0, 4096)
  return /<([\w-]+:)?(CrossIndustryInvoice|Invoice|CreditNote)[\s>]/.test(head)
}

/**
 * Finds the e-invoice XML embedded in a PDF (ZUGFeRD/Factur-X, also XRechnung attached to a PDF).
 * Embedded files are separate stream objects (never inside object streams), so the streams marked
 * as /EmbeddedFile are read directly; Flate-compressed streams are inflated with a size limit.
 * Returns null for PDFs without e-invoice (scans, ordinary PDFs) and for encrypted PDFs.
 */
export function extractPdfEinvoice(pdf: Buffer): { filename: string | null; xml: string } | null {
  const text = pdf.toString('latin1')
  if (!text.startsWith('%PDF-') || /\/Encrypt\s/.test(text)) return null
  const filename =
    KNOWN_NAMES.find((name) => text.includes(`(${name})`)) ??
    /\/UF?\s*\(([^()]{1,100}\.xml)\)/i.exec(text)?.[1] ??
    null
  // Keyword positions are memoised and the scan position only moves forward, so every byte is
  // searched at most once per keyword: crafted PDFs (many objects without streams) stay linear.
  const finder = (word: string) => {
    let pos = -1
    let gone = false
    return (from: number): number => {
      if (gone) return -1
      if (pos >= from) return pos
      pos = text.indexOf(word, from)
      if (pos < 0) gone = true
      return pos
    }
  }
  const nextStream = finder('stream')
  const nextEndobj = finder('endobj')
  const nextEndstream = finder('endstream')
  const objectStart = /\b\d+\s+\d+\s+obj\b/g
  let match: RegExpExecArray | null
  for (;;) {
    match = objectStart.exec(text)
    if (!match) break
    const from = match.index + match[0].length
    const streamAt = nextStream(from)
    if (streamAt < 0) break
    const endobjAt = nextEndobj(from)
    if (endobjAt >= 0 && endobjAt < streamAt) {
      objectStart.lastIndex = endobjAt + 6
      continue
    }
    const dict = text.slice(from, streamAt)
    let start = streamAt + 6
    if (text[start] === '\r') start++
    if (text[start] === '\n') start++
    const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1]
    const end = length ? start + Number(length) : nextEndstream(start)
    if (end <= start || end > pdf.length) {
      objectStart.lastIndex = start
      continue
    }
    objectStart.lastIndex = end
    if (
      !/\/Type\s*\/EmbeddedFile\b/.test(dict) &&
      !/\/Subtype\s*\/(text|application)#2Fxml/i.test(dict)
    ) {
      continue
    }
    let data = pdf.subarray(start, end)
    if (/\/Filter\s*(\[\s*)?\/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data, { maxOutputLength: MAX_XML_BYTES })
      } catch {
        continue
      }
    } else if (/\/Filter/.test(dict)) {
      continue
    }
    const xml = data.toString('utf8')
    if (looksLikeEinvoice(xml)) return { filename, xml }
  }
  return null
}
