/**
 * Semantic model of an invoice per EN 16931 (comments name the business terms BT-/BG-). Amounts are
 * cents, quantities and prices decimal strings. Built from a finalized document by
 * `einvoiceFromDocument()` and written as CII (ZUGFeRD/Factur-X, XRechnung) or UBL (XRechnung).
 */

/** UNTDID 5305 VAT category codes used in Germany. */
export type VatCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O' | 'L' | 'M'

/**
 * UNTDID 1001 subset of XRechnung: 380 commercial invoice, 326 partial invoice, 875 partial
 * construction invoice (Abschlag), 877 final construction invoice (Schlussrechnung), 384 corrected
 * invoice (Storno), 381 credit note.
 */
export type InvoiceTypeCode = '380' | '326' | '875' | '876' | '877' | '384' | '381'

export interface EinvoiceAddress {
  /** BT-35 / BT-50 */
  street: string | null
  /** BT-36 / BT-51 */
  streetExtra: string | null
  /** BT-38 / BT-53 */
  postalCode: string | null
  /** BT-37 / BT-52 */
  city: string | null
  /** BT-40 / BT-55, ISO 3166-1 alpha-2 */
  countryCode: string
}

/** BT-34 / BT-49: electronic address; EM = e-mail, 0204 = Leitweg-ID. */
export interface ElectronicAddress {
  scheme: 'EM' | '0204'
  value: string
}

export interface EinvoiceParty {
  /** BT-27 / BT-44 */
  name: string
  /** BT-46 buyer identifier (Kundennummer). */
  id: string | null
  address: EinvoiceAddress
  /** BT-31 / BT-48 */
  vatId: string | null
  /** BT-32 (seller only): Steuernummer, scheme FC. */
  taxNumber: string | null
  electronicAddress: ElectronicAddress | null
  /** BG-6 seller contact (BT-41..43). */
  contact: { name: string | null; phone: string | null; email: string | null } | null
}

export interface EinvoiceLine {
  /** BT-126 */
  id: string
  /** BT-153 */
  name: string
  /** BT-154 */
  description: string | null
  /** BT-129, may be negative (Storno). */
  quantity: string
  /** BT-130, UN/ECE Rec. 20/21 */
  unitCode: string
  /** BT-146 net price (never negative, BR-27). */
  netPrice: string
  /** BT-148 gross price and BT-147 price discount, when the position has a discount. */
  grossPrice: string | null
  priceDiscount: string | null
  /** BT-131 */
  netCents: bigint
  /** BT-151, BT-152 */
  vatCategory: VatCategory
  vatRate: string
}

/** BG-20 (allowance) / BG-21 (charge) on document level, per VAT category. */
export interface EinvoiceAllowanceCharge {
  charge: boolean
  /** BT-92 / BT-99, positive */
  amountCents: bigint
  /** BT-97 / BT-104 */
  reason: string
  /** BT-98 / BT-105 (UNTDID 5189 / 7161) */
  reasonCode: string | null
  vatCategory: VatCategory
  vatRate: string
}

/** BG-23 VAT breakdown. */
export interface EinvoiceVatBreakdown {
  category: VatCategory
  rate: string
  /** BT-116 */
  baseCents: bigint
  /** BT-117 */
  taxCents: bigint
  /** BT-120, BT-121 */
  exemptionReason: string | null
  exemptionCode: string | null
}

export interface EinvoiceModel {
  /** BT-1 */
  number: string
  /** BT-2 */
  issueDate: string
  /** BT-3 */
  typeCode: InvoiceTypeCode
  /** BT-5 */
  currency: 'EUR'
  /** BT-9 */
  dueDate: string | null
  /** BT-10: Leitweg-ID or another reference of the buyer. */
  buyerReference: string | null
  /** BT-11 project (Bauvorhaben). */
  project: { id: string; name: string } | null
  /** BT-22 */
  notes: string[]
  /** BG-14 (BT-73, BT-74) */
  period: { start: string; end: string } | null
  /** BT-72 */
  deliveryDate: string | null
  /** BT-80: deliver-to country (intra-community supply). */
  deliveryCountry: string | null
  /** BG-3 (BT-25, BT-26) */
  precedingInvoices: { number: string; date: string | null }[]
  seller: EinvoiceParty
  buyer: EinvoiceParty
  /** BG-16 / BG-17 and BT-20 */
  payment: {
    /** BT-81: 58 SEPA credit transfer, 1 not defined. */
    meansCode: '58' | '1'
    /** BT-83 */
    reference: string
    iban: string | null
    bic: string | null
    accountName: string | null
    /** BT-20 (incl. #SKONTO# line for XRechnung). */
    terms: string | null
  }
  lines: EinvoiceLine[]
  allowancesCharges: EinvoiceAllowanceCharge[]
  vatBreakdown: EinvoiceVatBreakdown[]
  /** BG-22 */
  totals: {
    /** BT-106 */
    lineNetCents: bigint
    /** BT-107 */
    allowanceCents: bigint
    /** BT-108 */
    chargeCents: bigint
    /** BT-109 */
    netCents: bigint
    /** BT-110 */
    taxCents: bigint
    /** BT-112 */
    grossCents: bigint
    /** BT-115 */
    dueCents: bigint
  }
}

/** Output formats: ZUGFeRD/Factur-X EN 16931 (CII, embedded in PDF/A-3) and XRechnung. */
export type EinvoiceFormat = 'zugferd' | 'xrechnung_ubl' | 'xrechnung_cii'

export const EN16931 = 'urn:cen.eu:en16931:2017'
export const XRECHNUNG = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0'
/** BT-23, required by XRechnung. */
export const BUSINESS_PROCESS = 'urn:fdc:peppol.eu:2017:poacc:billing:01.0'
