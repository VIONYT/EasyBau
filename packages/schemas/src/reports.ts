import { z } from 'zod'
import { id, isoDate, optionalText, text } from './common.js'
import { SIGNER_ROLES, type SUPPORTED_SECTION_TYPES, WEATHER_CONDITIONS } from './constants.js'
import { decimalText } from './documents.js'

export type SectionType = (typeof SUPPORTED_SECTION_TYPES)[number]
export type SignerRole = (typeof SIGNER_ROLES)[number]
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number]

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
}

export type WeatherValue = z.infer<typeof weatherValue>
export type StaffValue = z.infer<typeof staffValue>
export type QuantityRowsValue = z.infer<typeof quantityRowsValue>
export type EquipmentValue = z.infer<typeof equipmentValue>
export type TextValue = z.infer<typeof textValue>

// ---- Requests ------------------------------------------------------------------------------------

export const createReportRequest = z.object({
  templateKey: z.string().min(1).max(100).default('daily_site_report'),
  reportDate: isoDate.optional(),
})

export const updateReportRequest = z
  .object({
    reportDate: isoDate,
    serviceFrom: isoDate.nullable(),
    serviceTo: isoDate.nullable(),
    /** Section values by section id; each given section is replaced as a whole. */
    data: z.record(z.string().max(50), z.unknown()),
  })
  .partial()

export const addReportPhotoRequest = z.object({
  fileId: id,
  caption: optionalText(500),
})

export const signReportRequest = z.object({
  signatures: z
    .array(z.object({ role: z.enum(SIGNER_ROLES), name: text(200) }))
    .min(1, 'Mindestens eine Unterschrift.')
    .max(5),
})

export const reportListQuery = z.object({ template: z.string().max(100).optional() })

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
  completedAt: string | null
}
