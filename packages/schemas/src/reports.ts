import { z } from 'zod'
import { id, isoDate, optionalText, text } from './common.js'
import {
  CHECKLIST_STATES,
  SIGNER_ROLES,
  type SUPPORTED_SECTION_TYPES,
  WEATHER_CONDITIONS,
} from './constants.js'
import { decimalText } from './documents.js'

export type SectionType = (typeof SUPPORTED_SECTION_TYPES)[number]
export type SignerRole = (typeof SIGNER_ROLES)[number]
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number]
export type ChecklistState = (typeof CHECKLIST_STATES)[number]

export interface ReportSection {
  id: string
  type: SectionType
  label?: string
  /** signatures: who signs (Auftragnehmer, Auftraggeber, …). */
  roles?: SignerRole[]
  /** staff: prefill people and hours from the project team and the working hours. */
  transferTimes?: boolean
  /** header: Leistungszeitraum (Regiebericht). */
  servicePeriod?: boolean
  /** text: follow-up documents that can be started from this section (Vorkommnisse). */
  actions?: ('obstruction_notice' | 'change_order')[]
  /** measurement: the section refers to an Aufmaßblatt of the project (Aufmaß-Bericht). */
  linkedSheet?: boolean
  /** checklist: points the list starts with (custom templates). */
  items?: string[]
}

export interface ReportTemplateSummary {
  id: string
  key: string
  name: string
  billable: boolean
  sections: ReportSection[]
}

// ---- Section values (report.data, keyed by section id) ------------------------------------------

const hours = decimalText('Stunden', 3, 2).refine(
  (v) => Number(v) >= 0 && Number(v) <= 24,
  'Stunden: 0 bis 24.',
)
const quantity = decimalText('Menge', 12, 3)

export const weatherValue = z.object({
  condition: z.enum(WEATHER_CONDITIONS).nullable().default(null),
  temperatureMin: decimalText('Temperatur', 2, 1).nullable().default(null),
  temperatureMax: decimalText('Temperatur', 2, 1).nullable().default(null),
  note: optionalText(500),
})
export const staffValue = z.object({
  rows: z
    .array(
      z.object({
        name: text(200),
        userId: id.nullish(),
        hours,
        activity: optionalText(500),
      }),
    )
    .max(200),
})
export const quantityRowsValue = z.object({
  rows: z
    .array(
      z.object({
        description: text(500),
        quantity: quantity.nullish(),
        unitId: id.nullish(),
      }),
    )
    .max(200),
})
export const equipmentValue = z.object({
  rows: z.array(z.object({ description: text(500), hours: hours.nullish() })).max(100),
})
export const textValue = z.object({ text: z.string().max(20_000).default('') })
export const yesNoValue = z.object({ value: z.boolean().nullable() })
export const deadlineValue = z.object({ date: isoDate.nullable() })
export const checklistValue = z.object({
  rows: z
    .array(
      z.object({
        label: text(500),
        state: z.enum(CHECKLIST_STATES).nullable().default(null),
        note: optionalText(1000),
      }),
    )
    .max(200),
})
/** Aufmaß im Bericht: an Aufmaßblatt of the project and/or simple dimensions (Baustellenbegehung). */
export const measurementValue = z.object({
  sheetId: id.nullable().default(null),
  rows: quantityRowsValue.shape.rows.default([]),
})

/** Validation per section type; header, photos and signatures have no free values. */
export const SECTION_VALUE_SCHEMAS: Partial<Record<SectionType, z.ZodType>> = {
  weather: weatherValue,
  staff: staffValue,
  services: quantityRowsValue,
  materials: quantityRowsValue,
  equipment: equipmentValue,
  text: textValue,
  yes_no: yesNoValue,
  deadline: deadlineValue,
  checklist: checklistValue,
  measurement: measurementValue,
}

export type WeatherValue = z.infer<typeof weatherValue>
export type StaffValue = z.infer<typeof staffValue>
export type QuantityRowsValue = z.infer<typeof quantityRowsValue>
export type EquipmentValue = z.infer<typeof equipmentValue>
export type TextValue = z.infer<typeof textValue>
export type ChecklistValue = z.infer<typeof checklistValue>
export type MeasurementValue = z.infer<typeof measurementValue>

// ---- Requests ------------------------------------------------------------------------------------

export const createReportRequest = z.object({
  templateKey: z.string().min(1).max(100).default('daily_site_report'),
  reportDate: isoDate.optional(),
  /** Client-generated id (offline capture, DESIGN.md §6): replaying the same report is idempotent. */
  id: id.optional(),
})

export const updateReportRequest = z
  .object({
    reportDate: isoDate,
    serviceFrom: isoDate.nullable(),
    serviceTo: isoDate.nullable(),
    /** Regiebericht: day it was handed to the client (VOB/B § 15 Abs. 3). */
    submittedOn: isoDate.nullable(),
    /** Section values by section id; each given section is replaced as a whole. */
    data: z.record(z.string().max(50), z.unknown()),
  })
  .partial()

/** Photo straight from the camera into the report (stored in the project's Ablage, folder „Fotos“). */
export const uploadReportPhotoQuery = z.object({
  filename: z.string().trim().min(1, 'Dateiname fehlt.').max(500),
  caption: optionalText(500),
})

export const addReportPhotoRequest = z.object({
  fileId: id,
  caption: optionalText(500),
})

export const signReportRequest = z.object({
  signatures: z
    .array(
      z.object({
        role: z.enum(SIGNER_ROLES),
        name: text(200),
        /** Handwritten signature (PNG uploaded via POST /api/v1/signatures). */
        signatureAssetId: id.nullish(),
      }),
    )
    .min(1, 'Mindestens eine Unterschrift.')
    .max(5),
})

export const reportListQuery = z.object({ template: z.string().max(100).optional() })

/** Regie-/Einsatzberichte in eine Rechnung übernehmen (P2.5). */
export const applyReportsRequest = z.object({
  reportIds: z.array(id).min(1, 'Bitte mindestens einen Bericht auswählen.').max(50),
})

// ---- Responses -----------------------------------------------------------------------------------

export interface ReportSummary {
  id: string
  projectId: string
  template: { key: string; name: string }
  reportDate: string
  status: 'draft' | 'completed' | 'signed'
  /** Sum of staff hours. */
  totalHours: string
  staffCount: number
  photoCount: number
  weather: WeatherValue | null
  createdBy: { id: string; displayName: string } | null
  updatedAt: string
  /** Template is billable (Regie-, Einsatz-, Bautagesbericht, Abnahme). */
  billable: boolean
  /** Invoice the report was billed with (not cancelled); null while unbilled. */
  billedInvoice: { id: string; number: string | null } | null
  /** Regiebericht: handed to the client on (VOB/B § 15 Abs. 3). */
  submittedOn: string | null
  /** Regiebericht: deadlines for handing over and returning (else null). */
  daywork: DayworkDeadlineDto | null
}

export interface DayworkDeadlineDto {
  state: 'to_submit' | 'submit_overdue' | 'waiting' | 'deemed_accepted' | 'returned'
  submitBy: string | null
  returnBy: string | null
}

/** Report as candidate for an invoice draft (GET /documents/:id/reports). */
export interface BillableReport {
  id: string
  template: { key: string; name: string }
  reportDate: string
  serviceFrom: string | null
  serviceTo: string | null
  status: ReportSummary['status']
  totalHours: string
  /** Already taken over into this draft. */
  inThisDocument: boolean
  /** Why it cannot be taken over (unsigned, already billed or in another draft); null = possible. */
  blocked: string | null
}

export interface ReportPhoto {
  fileId: string
  filename: string
  caption: string | null
  isEvidence: boolean
}

export interface ReportSignature {
  role: SignerRole
  name: string
  signedAt: string
  /** Handwritten signature image (/api/v1/assets/:id), if drawn. */
  imageAssetId: string | null
}

export interface ReportDetail extends ReportSummary {
  project: { id: string; number: string | null; name: string }
  template: ReportTemplateSummary
  serviceFrom: string | null
  serviceTo: string | null
  /** Contractor, client and place of performance; frozen when the report is signed. */
  header: { contractor: string; client: string | null; placeOfPerformance: string | null }
  data: Record<string, unknown>
  photos: ReportPhoto[]
  signatures: ReportSignature[]
  /** Aufmaßblätter referenced by measurement sections. */
  linkedSheets: { id: string; title: string; measuredOn: string; status: string }[]
  completedAt: string | null
}
