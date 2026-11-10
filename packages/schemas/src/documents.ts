import { z } from 'zod'
import { id, isoDate, optionalText } from './common.js'
import {
  CHANGE_ORDER_BASES,
  COST_KINDS,
  CREATABLE_INVOICE_KINDS,
  DOCUMENT_TYPES,
  EDITABLE_POSITION_TYPES,
  type EditablePositionType,
  PRICED_POSITION_TYPES,
  TAX_MODES,
} from './constants.js'
import type { LetterheadLayout } from './letterhead.js'
import type { Receivable } from './receivables.js'

export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export type InvoiceKind = (typeof CREATABLE_INVOICE_KINDS)[number] | 'cancellation'

export type ChangeOrderBasis = (typeof CHANGE_ORDER_BASES)[number]

export type TaxMode = (typeof TAX_MODES)[number]

export type DocumentStatus =
  | 'draft'
  | 'finalized'
  | 'sent'
  | 'accepted'
  | 'partially_accepted'
  | 'rejected'
  | 'cancelled'

/**
 * Decimal number as text, German or English notation („12,5“ / „12.5“), with at most
 * `decimals` places (default 4, e.g. room dimensions like 0,885 m).
 */
export const decimalText = (label: string, max = 14, decimals = 4) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim().replace(',', '.'))
    .pipe(
      z
        .string()
        .regex(
          new RegExp(`^-?\\d{1,${max}}(\\.\\d{1,${decimals}})?$`),
          `${label}: Zahl mit höchstens ${decimals} Nachkommastellen erwartet.`,
        ),
    )
const percent = (label: string) =>
  decimalText(label, 3).refine(
    (v) => Number(v) >= 0 && Number(v) <= 100,
    `${label} muss zwischen 0 und 100 liegen.`,
  )
const cents = z
  .number()
  .int('Betrag in Cent (ganze Zahl) erwartet.')
  .min(-100_000_000_000)
  .max(100_000_000_000)

export const createDocumentRequest = z
  .object({
    type: z.enum(DOCUMENT_TYPES, 'Unbekannter Dokumenttyp.'),
    invoiceKind: z.enum(CREATABLE_INVOICE_KINDS).optional(),
    /** Copy positions, texts, recipient and place of performance from this document. */
    sourceDocumentId: id.optional(),
    subject: optionalText(300),
    /** Change orders: legal basis (VOB/B § 2 Abs. 5/6, BGB § 650b) and reason. */
    basis: z.enum(CHANGE_ORDER_BASES).optional(),
    reason: optionalText(2000),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'invoice' && !value.invoiceKind) {
      ctx.addIssue({ code: 'custom', path: ['invoiceKind'], message: 'Rechnungsart fehlt.' })
    }
    if (value.type !== 'invoice' && value.invoiceKind) {
      ctx.addIssue({
        code: 'custom',
        path: ['invoiceKind'],
        message: 'Eine Rechnungsart gibt es nur bei Rechnungen.',
      })
    }
  })
export type CreateDocumentRequest = z.infer<typeof createDocumentRequest>

export const updateDocumentRequest = z
  .object({
    subject: optionalText(300),
    documentDate: isoDate,
    serviceFrom: isoDate.nullable(),
    serviceTo: isoDate.nullable(),
    placeOfPerformance: optionalText(500),
    contactId: id.nullable(),
    introText: optionalText(10_000),
    closingText: optionalText(10_000),
    paymentDueDays: z.number().int().min(0).max(365).nullable(),
    discountPercent: percent('Gesamtrabatt').nullable(),
    taxMode: z.enum(TAX_MODES),
    /** Angebot: Bindefrist. */
    validUntil: isoDate.nullable(),
    /** Rechnungen: Skonto, Sicherheitseinbehalt, Bauumlage, Abschlagsart. */
    cashDiscountPercent: percent('Skonto').nullable(),
    cashDiscountDays: z.number().int().min(0).max(365).nullable(),
    retentionPercent: percent('Sicherheitseinbehalt').nullable(),
    constructionLevyPercent: percent('Bauumlage').nullable(),
    progressBillingMode: z.enum(['cumulative', 'individual']),
  })
  .partial()
  .superRefine((value, ctx) => {
    if (
      (value.cashDiscountPercent !== undefined || value.cashDiscountDays !== undefined) &&
      (value.cashDiscountPercent == null) !== (value.cashDiscountDays == null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cashDiscountDays'],
        message: 'Skonto braucht Prozent und Tage.',
      })
    }
    if (value.serviceFrom && value.serviceTo && value.serviceTo < value.serviceFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['serviceTo'],
        message: 'Das Ende darf nicht vor dem Beginn liegen.',
      })
    }
  })
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequest>

const itemFields = {
  shortText: optionalText(500),
  longText: optionalText(20_000),
  // At most the decimals of the unit (checked on the server: m² 2, m³/t 3, Stück 0), so the
  // printed Menge × EP always equals the Gesamtpreis.
  quantity: decimalText('Menge', 14, 3).nullable(),
  unitId: id.nullable(),
  unitPriceCents: cents.nullable(),
  discountPercent: percent('Rabatt').nullable(),
  taxRatePercent: percent('Steuersatz').nullable(),
}

export const createItemRequest = z
  .object({
    positionType: z.enum(EDITABLE_POSITION_TYPES, 'Unbekannter Positionstyp.'),
    /** Enclosing title; omitted or null: top level. */
    parentId: id.nullish(),
    ...itemFields,
  })
  .partial({
    shortText: true,
    longText: true,
    quantity: true,
    unitId: true,
    unitPriceCents: true,
    discountPercent: true,
    taxRatePercent: true,
  })
  .superRefine((value, ctx) => {
    if (PRICED_POSITION_TYPES.includes(value.positionType)) {
      if (!value.shortText)
        ctx.addIssue({ code: 'custom', path: ['shortText'], message: 'Kurztext fehlt.' })
      if (value.positionType !== 'lump_sum') {
        if (!value.quantity)
          ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Menge fehlt.' })
        if (!value.unitId)
          ctx.addIssue({ code: 'custom', path: ['unitId'], message: 'Einheit fehlt.' })
      }
    } else if (value.positionType === 'title' && !value.shortText) {
      ctx.addIssue({ code: 'custom', path: ['shortText'], message: 'Titel fehlt.' })
    }
  })
export type CreateItemRequest = z.infer<typeof createItemRequest>

export const updateItemRequest = z.object(itemFields).partial()
export type UpdateItemRequest = z.infer<typeof updateItemRequest>

export const moveItemRequest = z.object({ direction: z.enum(['up', 'down']) })

export type CostKind = (typeof COST_KINDS)[number]

/** Kalkulation of a position: cost lines with markup → EP (DESIGN.md §4.2). */
export const calculationRequest = z.object({
  calcMode: z.enum(['unit_price', 'total_price']).default('unit_price'),
  lines: z
    .array(
      z.object({
        kind: z.enum(COST_KINDS),
        description: optionalText(300),
        quantity: decimalText('Menge', 10, 4),
        unitId: id.nullish(),
        /** Cost per unit in cents; labor in min/Std: hourly rate (Stundensatz). */
        unitCostCents: cents.refine((v) => v >= 0, 'Kosten dürfen nicht negativ sein.'),
        /** Zuschlag in percent; omitted: company default for the cost kind. */
        markupPercent: decimalText('Zuschlag', 4, 4).nullish(),
      }),
    )
    .max(50),
})
export type CalculationRequest = z.infer<typeof calculationRequest>

/** Schalter „Nachtragsangebot“: a draft quote becomes a change order and back. */
export const convertDocumentRequest = z.object({
  to: z.enum(['quote', 'change_order']),
  basis: z.enum(CHANGE_ORDER_BASES).optional(),
  reason: optionalText(2000),
})

/**
 * Storno (DESIGN.md §4.1): a Stornorechnung with its own number cancels the invoice completely;
 * `reissue` additionally creates a corrected copy as a new draft („Rechnung korrigieren“).
 */
export const cancelInvoiceRequest = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Bitte einen Grund für das Storno angeben.')
    .max(500, 'Der Grund darf höchstens 500 Zeichen lang sein.'),
  reissue: z.boolean().default(false),
})

export interface CancelInvoiceResult {
  cancellation: { id: string; number: string }
  /** New draft („Rechnung korrigieren“). */
  reissue: { id: string } | null
}

/** Festschreiben: warnings (e.g. free positions) must be confirmed explicitly. */
export const finalizeRequest = z.object({ acknowledgeWarnings: z.boolean().default(false) })

/** Result of the check before finalizing an invoice (Pflichtangaben, Regel 12). */
export interface FinalizeCheck {
  /** Blocking problems (German), with the field to fix. */
  errors: { field: string; message: string }[]
  /** Need confirmation, e.g. positions that are not part of the contract. */
  warnings: { field: string; message: string }[]
  /** Number the document will get (preview; drawn only when finalizing). */
  numberPreview: string | null
}

/** After completion: sent → accepted / rejected (quotes, cost estimates, change orders). */
export const documentStatusRequest = z.object({
  status: z.enum(['sent', 'accepted', 'rejected']),
})

export interface DocumentOption {
  type: DocumentType
  invoiceKind: InvoiceKind | null
  available: boolean
  /** Why the type is not available yet (German). */
  reason: string | null
  /** Next number of a progress invoice („2. Abschlagsrechnung“). */
  progressNo: number | null
}

export interface DocumentSummary {
  id: string
  projectId: string
  type: DocumentType
  invoiceKind: InvoiceKind | null
  progressNo: number | null
  status: DocumentStatus
  number: string | null
  subject: string | null
  documentDate: string
  netTotalCents: number
  grossTotalCents: number
  createdBy: { id: string; displayName: string } | null
  updatedAt: string
  changeOrder: { number: number; basis: ChangeOrderBasis; status: string } | null
  /** Finalized cancellation of this invoice: the invoice is locked, its number stays used. */
  cancelledBy: { id: string; number: string } | null
  /** For a cancellation: the invoice it cancels. */
  cancels: { id: string; number: string | null } | null
}

export interface DocumentItem {
  id: string
  parentId: string | null
  positionType: EditablePositionType | 'subtotal' | 'image'
  oz: string | null
  /** Depth in the outline (0 = top level). */
  level: number
  shortText: string | null
  longText: string | null
  quantity: string | null
  unit: UnitRef | null
  unitPriceCents: number | null
  discountPercent: string | null
  totalCents: number | null
  taxRatePercent: string | null
  /** Quantity was taken over from the measurement (Aufmaß). */
  fromMeasurement: boolean
  /** Rechnungen: Leistungsstand laut Leistungsaufmaß and quantity already billed before. */
  cumulativeQuantity: string | null
  previouslyBilledQuantity: string | null
  calcMode: 'unit_price' | 'total_price' | null
  /** Kostenzeilen; empty: the price is entered directly. */
  costLines: CostLine[]
  /** Only for calculated positions. */
  calculation: {
    costCents: number
    marginCents: number
    marginPercent: string | null
    laborHours: string
  } | null
}

export interface CostLine {
  id: string
  kind: CostKind
  description: string | null
  quantity: string
  unit: UnitRef | null
  unitCostCents: number
  markupPercent: string
}

export interface DocumentTaxLine {
  category: string
  ratePercent: string
  netCents: number
  taxCents: number
  exemptionReason: string | null
  /** netCents = itemsNetCents − discountCents − deductedNetCents (allowances in the e-invoice). */
  itemsNetCents: number
  discountCents: number
  deductedNetCents: number
}

/** An earlier invoice deducted by a Schlussrechnung / kumulative Abschlagsrechnung. */
export interface DeductionSummary {
  documentId: string
  number: string | null
  invoiceKind: InvoiceKind | null
  progressNo: number | null
  documentDate: string
  netCents: number
  taxCents: number
  grossCents: number
}

export interface DocumentTotals {
  /** Gesamtleistung; equals net/tax/gross unless earlier invoices are deducted. */
  performance: { netCents: number; taxCents: number; grossCents: number }
  deductions: DeductionSummary[]
  retentionCents: number
  constructionLevyCents: number
  /** Zahlbetrag: gross − Sicherheitseinbehalt − Bauumlage. */
  payableCents: number
  cashDiscountCents: number
  itemsNetCents: number
  discountCents: number
  netCents: number
  taxCents: number
  grossCents: number
  taxLines: DocumentTaxLine[]
  /** Title id → subtotal of the positions below it. */
  titleSubtotals: Record<string, number>
  /** Kalkulation of the counted positions: cost, margin and planned labor hours (Soll-Stunden). */
  costCents: number
  marginCents: number
  laborHours: string
  /** Counted positions without calculation (price entered directly). */
  uncalculatedCount: number
}

/** Structured address for the e-invoice (EN 16931 BG-5 / BG-8). */
export interface PostalAddress {
  street: string | null
  streetExtra: string | null
  postalCode: string | null
  city: string | null
  /** ISO 3166-1 alpha-2 */
  countryCode: string
}

export type EinvoiceFormat = 'zugferd' | 'xrechnung_ubl' | 'xrechnung_cii'

export interface PartyAddress {
  name: string
  lines: string[]
  /** Recipient is a private person (Aufbewahrungshinweis § 14 Abs. 4 Nr. 9 UStG). */
  private?: boolean
  /** USt-IdNr. of the recipient. */
  vatId?: string | null
  /** Structured address for the e-invoice; frozen with the document (since migration 0020). */
  address?: PostalAddress | null
  /** Recipient: Kundennummer (BT-46), Leitweg-ID (BT-10/BT-49), e-invoice address and format. */
  customerNumber?: string | null
  buyerReference?: string | null
  einvoiceEmail?: string | null
  einvoiceFormat?: EinvoiceFormat | null
}

/** E-Rechnung of a finalized invoice: the archived XML files, each validated by KoSIT. */
export interface EinvoiceSummary {
  files: { format: EinvoiceFormat; validatedAt: string; sizeBytes: number; sha256: string }[]
}

/** Revisionssicheres Archiv (ADR 0008): originals of a finalized document and their WORM copies. */
export interface DocumentArchive {
  /** A WORM archive is configured (otherwise originals are only in the files volume). */
  enabled: boolean
  /** Archived originals (PDF, e-invoice XML, validation report). */
  files: number
  /** Of those already copied into the WORM bucket. */
  archived: number
  /** End of the retention period (§ 147 AO). */
  retainUntil: string | null
  /** All originals archived: time of the last copy; otherwise null (pending). */
  archivedAt: string | null
}

/** Firma data the e-invoice needs beyond the letter (frozen with the document since 0020). */
export interface IssuerEinvoiceData {
  vatId: string | null
  taxNumber: string | null
  email: string | null
  phone: string | null
  /** BT-41 contact point, e.g. the Geschäftsführung. */
  contactName: string | null
  /** IBAN without spaces (BT-84), BIC (BT-86), bank (account name is the company). */
  iban: string | null
  bic: string | null
}

export interface DocumentDetail extends DocumentSummary {
  project: { id: string; number: string | null; name: string }
  contact: { id: string; displayName: string } | null
  placeOfPerformance: string | null
  serviceFrom: string | null
  serviceTo: string | null
  introText: string | null
  closingText: string | null
  paymentDueDays: number | null
  discountPercent: string | null
  taxMode: TaxMode
  /** Rechnungen. */
  cashDiscountPercent: string | null
  cashDiscountDays: number | null
  retentionPercent: string | null
  constructionLevyPercent: string | null
  progressBillingMode: 'cumulative' | 'individual' | null
  /** Fälligkeit: document date + payment term (set when finalized). */
  dueDate: string | null
  cancelReason: string | null
  /** Pflichthinweise (§ 13b, Skonto, Aufbewahrung …); frozen when finalized. */
  legalNotes: string[]
  sourceDocumentId: string | null
  validUntil: string | null
  /**
   * Firma (Absender) and Empfänger; snapshots once the document is completed. The letterhead and
   * its placeholder values are frozen with it (missing in documents finalized before 0018).
   */
  issuer: PartyAddress & {
    contact: string[]
    legal: string[]
    einvoice?: IssuerEinvoiceData
    letterhead?: LetterheadLayout
    values?: Record<string, string | null>
  }
  recipient: PartyAddress | null
  finalizedAt: string | null
  /** Change orders: main contract, reason. */
  changeOrderInfo: { contractId: string; contractLabel: string; reason: string | null } | null
  /** Schalter „Nachtragsangebot“ possible (draft quote/change order with a main contract). */
  canConvertToChangeOrder: boolean
  items: DocumentItem[]
  totals: DocumentTotals
  /** Finalized invoices: archived e-invoice files (ZUGFeRD, XRechnung), validated by KoSIT. */
  einvoice?: EinvoiceSummary | null
  /** Finalized invoices and credit notes: payments, deductions, open amount, status. */
  receivable?: Receivable | null
  /** Finalized documents: state of the revisionssichere Archiv. */
  archive?: DocumentArchive | null
}

/** Unit with its decimal places (Handwerksregel: m/m² 2, m³ und t 3, Stück/Pauschal 0). */
export interface UnitRef {
  id: string
  symbol: string
  decimals: number
}

export interface UnitSummary extends UnitRef {
  name: string
  dimension: string
}

export interface TaxRateSummary {
  id: string
  name: string
  percent: string
  categoryCode: string
  isDefault: boolean
}
