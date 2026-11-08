import { z } from 'zod'
import { id, isoDate, optionalText } from './common.js'
import {
  CHANGE_ORDER_BASES,
  CREATABLE_INVOICE_KINDS,
  DOCUMENT_TYPES,
  EDITABLE_POSITION_TYPES,
  type EditablePositionType,
  PRICED_POSITION_TYPES,
  TAX_MODES,
} from './constants.js'

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

/** Decimal number as text, German or English notation („12,5“ / „12.5“), up to 4 decimals. */
export const decimalText = (label: string, max = 14) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim().replace(',', '.'))
    .pipe(
      z
        .string()
        .regex(
          new RegExp(`^-?\\d{1,${max}}(\\.\\d{1,4})?$`),
          `${label}: Zahl mit höchstens 4 Nachkommastellen erwartet.`,
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
  })
  .partial()
  .superRefine((value, ctx) => {
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
  quantity: decimalText('Menge').nullable(),
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
  unit: { id: string; symbol: string } | null
  unitPriceCents: number | null
  discountPercent: string | null
  totalCents: number | null
  taxRatePercent: string | null
}

export interface DocumentTaxLine {
  category: string
  ratePercent: string
  netCents: number
  taxCents: number
  exemptionReason: string | null
}

export interface DocumentTotals {
  itemsNetCents: number
  discountCents: number
  netCents: number
  taxCents: number
  grossCents: number
  taxLines: DocumentTaxLine[]
  /** Title id → subtotal of the positions below it. */
  titleSubtotals: Record<string, number>
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
  sourceDocumentId: string | null
  items: DocumentItem[]
  totals: DocumentTotals
}

export interface UnitSummary {
  id: string
  symbol: string
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
