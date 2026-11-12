import { z } from 'zod'
import { id, isoDate, listQuery, optionalText, text } from './common.js'
import { COST_TYPES, type INCOMING_SOURCES, INCOMING_STATUSES } from './constants.js'

/**
 * Eingangsrechnungen (P1.11): received invoices with review ("Zu prüfen"), cost allocation to
 * projects or business areas, "Prüfung bestätigen" and payment status. No bookkeeping.
 */
export type IncomingStatus = (typeof INCOMING_STATUSES)[number]
export type IncomingSource = (typeof INCOMING_SOURCES)[number]
export type CostType = (typeof COST_TYPES)[number]

/** Amounts in cents, at most 100 million euros. */
const cents = z
  .number('Betrag fehlt.')
  .int('Betrag in Cent erwartet.')
  .min(0, 'Der Betrag darf nicht negativ sein.')
  .max(10_000_000_000, 'Der Betrag ist zu groß.')
const rate = z
  .string()
  .trim()
  .regex(/^\d{1,2}([.,]\d{1,2})?$/, 'Steuersatz in Prozent, z. B. 19 oder 7.')
  .transform((v) => v.replace(',', '.'))

export const uploadIncomingQuery = z.object({ filename: text(200) })

export const incomingListQuery = listQuery.extend({
  status: z.enum(INCOMING_STATUSES).optional(),
  /** Zahlstatus of confirmed invoices. */
  payment: z.enum(['open', 'overdue', 'paid']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  projectId: id.optional(),
  businessAreaId: id.optional(),
})
export type IncomingListQuery = z.infer<typeof incomingListQuery>

export const incomingTaxLineInput = z.object({
  ratePercent: rate,
  netCents: cents,
  taxCents: cents,
})

export const incomingAllocationInput = z.object({
  projectId: id.nullable().default(null),
  businessAreaId: id.nullable().default(null),
  costType: z.enum(COST_TYPES, 'Unbekannte Kostenart.'),
  ratePercent: rate,
  netCents: cents.positive('Der Betrag muss größer als 0 sein.'),
  description: optionalText(500),
})
export type IncomingAllocationInput = z.infer<typeof incomingAllocationInput>

/** Review data; fields left out stay unchanged. */
export const updateIncomingRequest = z.object({
  documentKind: z.enum(['invoice', 'credit_note']).optional(),
  contactId: id.nullable().optional(),
  supplierName: optionalText(200),
  supplierVatId: optionalText(30),
  supplierTaxNumber: optionalText(30),
  supplierAddress: optionalText(500),
  supplierIban: optionalText(34),
  invoiceNumber: optionalText(100),
  invoiceDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  netCents: cents.optional(),
  taxCents: cents.optional(),
  grossCents: cents.optional(),
  reverseCharge: z.boolean().optional(),
  note: optionalText(2000),
  taxLines: z.array(incomingTaxLineInput).max(10, 'Höchstens 10 Steuersätze.').optional(),
  allocations: z.array(incomingAllocationInput).max(50, 'Höchstens 50 Zuweisungen.').optional(),
})
export type UpdateIncomingRequest = z.infer<typeof updateIncomingRequest>

/** Verwerfen (before confirmation) and Stornieren (after) need a reason. */
export const closeIncomingRequest = z.object({ reason: text(500) })

/** Zahlstatus: paid on a date, or null = open again. */
export const incomingPaymentRequest = z.object({
  paidOn: isoDate.nullable(),
  note: optionalText(500),
})

export const createBusinessAreaRequest = z.object({
  name: text(100),
  sort: z.number().int().min(0).max(10_000).optional(),
})
export const updateBusinessAreaRequest = z.object({
  name: text(100).optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
  archived: z.boolean().optional(),
})

export interface BusinessArea {
  id: string
  name: string
  sort: number
  archived: boolean
}

export interface IncomingParty {
  name: string | null
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

/** The e-invoice as read from the XML (readable view, "lesbare Darstellung"). */
export interface IncomingEinvoiceView {
  syntax: 'cii' | 'ubl'
  documentKind: 'invoice' | 'credit_note'
  specification: string | null
  profile: { label: string; en16931: boolean }
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
  lines: {
    id: string | null
    name: string | null
    description: string | null
    quantity: string | null
    unitCode: string | null
    netPrice: string | null
    netCents: number | null
    vatCategory: string | null
    vatRate: string | null
  }[]
  vatBreakdown: {
    category: string | null
    rate: string | null
    baseCents: number | null
    taxCents: number | null
    exemptionReason: string | null
  }[]
  totals: {
    lineNetCents: number | null
    allowanceCents: number | null
    chargeCents: number | null
    netCents: number | null
    taxCents: number | null
    grossCents: number | null
    prepaidCents: number | null
    dueCents: number | null
  }
}

export interface IncomingTaxLine {
  ratePercent: string
  netCents: number
  taxCents: number
}

export interface IncomingAllocation {
  id: string
  projectId: string | null
  projectName: string | null
  businessAreaId: string | null
  businessAreaName: string | null
  costType: CostType
  ratePercent: string
  netCents: number
  description: string | null
}

export interface IncomingRequirement {
  field: string
  message: string
}

export interface IncomingInvoiceListItem {
  id: string
  status: IncomingStatus
  documentKind: 'invoice' | 'credit_note'
  source: IncomingSource
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  netCents: number
  grossCents: number
  paidOn: string | null
  overdue: boolean
  reverseCharge: boolean
  /** E-invoice checked by KoSIT: true/false, null = no e-invoice or not checked. */
  einvoiceValid: boolean | null
  /** Projects and business areas, e.g. "Neubau Müller, Lager". */
  allocatedTo: string[]
  receivedAt: string
}

export interface IncomingInvoiceList {
  items: IncomingInvoiceListItem[]
  nextCursor: string | null
  /** Number of invoices waiting for review (badge). */
  reviewCount: number
}

export interface IncomingInvoiceDetail extends IncomingInvoiceListItem {
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  /** The original can be shown in the browser (PDF, picture). */
  inline: boolean
  contactId: string | null
  supplierVatId: string | null
  supplierTaxNumber: string | null
  supplierAddress: string | null
  supplierIban: string | null
  taxCents: number
  note: string | null
  paymentNote: string | null
  taxLines: IncomingTaxLine[]
  allocations: IncomingAllocation[]
  einvoice: IncomingEinvoiceView | null
  einvoiceProfile: string | null
  /** Structured invoice per EN 16931 (false for ZUGFeRD MINIMUM/BASIC WL). */
  einvoiceEn16931: boolean | null
  einvoiceMessages: {
    level: 'error' | 'warning' | 'information'
    code: string | null
    text: string
  }[]
  /** Blocking for "Prüfung bestätigen". */
  problems: IncomingRequirement[]
  warnings: IncomingRequirement[]
  /** Other invoices of the same supplier with the same number. */
  duplicates: {
    id: string
    invoiceNumber: string | null
    invoiceDate: string | null
    status: IncomingStatus
  }[]
  uploadedBy: string | null
  confirmedAt: string | null
  confirmedBy: string | null
  closedAt: string | null
  closeReason: string | null
  archive: { archived: boolean; retainUntil: string }
  canEdit: boolean
}
