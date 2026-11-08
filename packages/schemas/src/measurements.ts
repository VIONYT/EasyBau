import { z } from 'zod'
import { id, isoDate, optionalText, text } from './common.js'
import { MEASUREMENT_KINDS } from './constants.js'
import { type DocumentType, decimalText, type InvoiceKind, type UnitRef } from './documents.js'

export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number]

/** Room dimensions as variables, e.g. { L: "4,25", B: "3,1", H: "2,6" }. */
export const measurementVariables = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,15}$/, 'Variablennamen: Buchstaben, Ziffern, _ (max. 16).'),
    decimalText('Wert'),
  )
  .refine((v) => Object.keys(v).length <= 20, 'Höchstens 20 Variablen.')

export const createSheetRequest = z.object({
  kind: z.enum(MEASUREMENT_KINDS, 'Bitte Angebots- oder Leistungsaufmaß wählen.'),
  title: optionalText(200),
  measuredOn: isoDate.optional(),
})
export type CreateSheetRequest = z.infer<typeof createSheetRequest>

export const updateSheetRequest = z
  .object({ title: text(200), measuredOn: isoDate, kind: z.enum(MEASUREMENT_KINDS) })
  .partial()

export const signSheetRequest = z.object({
  contractorName: text(200),
  clientName: text(200),
})

export const locationRequest = z.object({
  name: text(200),
  parentId: id.nullish(),
  variables: measurementVariables.default({}),
})
export const updateLocationRequest = z
  .object({ name: text(200), variables: measurementVariables })
  .partial()

const lineFields = {
  description: optionalText(500),
  formula: z.string().trim().min(1, 'Bitte eine Formel oder Zahl eingeben.').max(500),
  locationId: id.nullable(),
  documentItemId: id.nullable(),
  unitId: id.nullable(),
  isDeduction: z.boolean(),
  variables: measurementVariables,
}
export const createLineRequest = z.object(lineFields).partial({
  description: true,
  locationId: true,
  documentItemId: true,
  unitId: true,
  isDeduction: true,
  variables: true,
})
export type CreateLineRequest = z.infer<typeof createLineRequest>
export const updateLineRequest = z.object(lineFields).partial()
export type UpdateLineRequest = z.infer<typeof updateLineRequest>

export interface MeasurementSheetSummary {
  id: string
  projectId: string
  kind: MeasurementKind
  title: string
  measuredOn: string
  status: 'draft' | 'signed'
  lineCount: number
  createdBy: { id: string; displayName: string } | null
  updatedAt: string
}

export interface MeasurementLocation {
  id: string
  parentId: string | null
  name: string
  /** Own variables (input format, e.g. "4.25"). */
  variables: Record<string, string>
  /** Path for display, e.g. „Haus A › EG › Bad“. */
  path: string
  level: number
}

/** LV position a line can be assigned to (no prices: site roles see this list). */
export interface MeasurableDocumentRef {
  id: string
  type: DocumentType
  invoiceKind: InvoiceKind | null
  progressNo: number | null
  number: string | null
  status: string
  /** Change orders: N01, N02 … */
  changeOrderNumber: number | null
}

export interface MeasurableItem {
  id: string
  document: MeasurableDocumentRef
  oz: string | null
  shortText: string
  quantity: string
  unit: UnitRef | null
  /** Sum of all lines of this kind (Angebots- or Leistungsaufmaß) in the project for this position. */
  measuredQuantity: string
}

export interface MeasurementLine {
  id: string
  locationId: string | null
  documentItemId: string | null
  description: string | null
  formula: string
  variables: Record<string, string>
  resultQty: string
  isDeduction: boolean
  unit: UnitRef | null
  locked: boolean
  createdAt: string
}

export interface ItemQuantitySummary {
  item: MeasurableItem
  /** Sum of the lines on this sheet. */
  sheetQuantity: string
  variance: {
    difference: string
    percent: string | null
    direction: 'more' | 'less' | 'equal'
    exceedsThreshold: boolean
  }
}

export interface MeasurementSheetDetail extends MeasurementSheetSummary {
  project: { id: string; number: string | null; name: string }
  signedAt: string | null
  signedByContractor: string | null
  signedByClient: string | null
  locations: MeasurementLocation[]
  lines: MeasurementLine[]
  /** Per assigned LV position: quantity on this sheet, measured total and deviation (VOB/B § 2 Abs. 3). */
  items: ItemQuantitySummary[]
  /** Sum of lines without LV position, per unit. */
  unassigned: { unit: string | null; decimals: number; quantity: string; count: number }[]
}
