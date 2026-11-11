import { z } from 'zod'
import { countryCode, email, id, optionalText, text } from './common.js'
import { COST_KINDS, DOCUMENT_TYPES } from './constants.js'
import { type CostKind, decimalText } from './documents.js'

const percent = (label: string) => decimalText(label, 3, 4)
const cents = z.number().int('Betrag in Cent (ganze Zahl) erwartet.').min(0).max(100_000_000_00)

// ---- Firma ----------------------------------------------------------------------------------

/** German IBAN check (ISO 13616 mod 97), spaces allowed. */
const iban = z
  .string()
  .transform((v) => v.replace(/\s+/g, '').toUpperCase())
  .refine((v) => v === '' || /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v), 'Ungültige IBAN.')
  .refine((v) => {
    if (v === '') return true
    const rearranged = v.slice(4) + v.slice(0, 4)
    const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
    let rest = 0
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97
    return rest === 1
  }, 'Die Prüfziffer der IBAN stimmt nicht.')
  .transform((v) => (v === '' ? null : v))

export const companyRequest = z
  .object({
    name: text(200),
    legalForm: optionalText(50),
    trade: optionalText(100),
    street: optionalText(200),
    postalCode: optionalText(20),
    city: optionalText(100),
    countryCode,
    federalState: optionalText(50),
    email: z.union([email, z.literal('')]).transform((v) => v || null),
    phone: optionalText(50),
    website: optionalText(200),
    vatId: optionalText(20),
    taxNumber: optionalText(30),
    registerCourt: optionalText(100),
    registerNumber: optionalText(50),
    managerTitle: optionalText(50),
    managerName: optionalText(200),
    bankName: optionalText(100),
    iban: iban.nullable(),
    bic: optionalText(11),
  })
  .partial()
export type CompanyRequest = z.infer<typeof companyRequest>

export interface Company {
  name: string
  legalForm: string | null
  trade: string | null
  street: string | null
  postalCode: string | null
  city: string | null
  countryCode: string
  federalState: string | null
  email: string | null
  phone: string | null
  website: string | null
  vatId: string | null
  taxNumber: string | null
  registerCourt: string | null
  registerNumber: string | null
  managerTitle: string | null
  managerName: string | null
  bankName: string | null
  /** Decrypted for the settings screen (stored encrypted). */
  iban: string | null
  bic: string | null
}

// ---- Nummernkreise ----------------------------------------------------------------------------

export interface NumberSequence {
  kind: string
  /** Schema with placeholders, e.g. „R{Jahr}-{Nummer}“ (packages/domain numbering.ts). */
  pattern: string
  nextValue: number
  minLength: number
  resetYearly: boolean
  /** Example of the next number, e.g. „R2026-00101“. */
  preview: string
}

export const numberSequenceRequest = z
  .object({
    pattern: z.string().trim().max(40, 'Das Schema darf höchstens 40 Zeichen lang sein.'),
    nextValue: z.number().int().min(0).max(1_000_000_000),
    minLength: z.number().int().min(1).max(12),
    resetYearly: z.boolean(),
  })
  .partial()

// ---- Zahlungsziele, Steuersätze -----------------------------------------------------------------

export const paymentTermRequest = z
  .object({
    name: text(100),
    dueDays: z.number().int().min(0).max(365),
    cashDiscountPercent: percent('Skonto').nullable(),
    cashDiscountDays: z.number().int().min(0).max(365).nullable(),
    isDefault: z.boolean(),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (
      (v.cashDiscountPercent == null) !== (v.cashDiscountDays == null) &&
      (v.cashDiscountPercent !== undefined || v.cashDiscountDays !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cashDiscountDays'],
        message: 'Skonto braucht Prozent und Tage.',
      })
    }
  })

export interface PaymentTerm {
  id: string
  name: string
  dueDays: number
  cashDiscountPercent: string | null
  cashDiscountDays: number | null
  isDefault: boolean
}

export const taxRateRequest = z
  .object({
    name: text(200),
    percent: percent('Steuersatz'),
    categoryCode: z.enum(['S', 'Z', 'E', 'AE', 'K', 'G', 'O']),
    isDefault: z.boolean(),
    validTo: z.iso.date().nullable(),
  })
  .partial()

// ---- Zuschläge, Lohngruppen ----------------------------------------------------------------------

export const surchargesRequest = z.partialRecord(z.enum(COST_KINDS), percent('Zuschlag'))
export type Surcharges = Record<CostKind, string>

export const wageGroupRequest = z
  .object({
    name: text(100),
    costPerHourCents: cents,
    markupPercent: percent('Zuschlag'),
    isActive: z.boolean(),
  })
  .partial()

export interface WageGroup {
  id: string
  name: string
  costPerHourCents: number
  markupPercent: string
  /** Stundenverrechnungssatz = Kosten × (1 + Zuschlag). */
  hourlyRateCents: number
  isActive: boolean
}

// ---- Einheiten -------------------------------------------------------------------------------

export const UNIT_DIMENSIONS = [
  'length',
  'area',
  'volume',
  'mass',
  'time',
  'count',
  'container',
  'lump_sum',
  'power',
] as const

export const unitRequest = z
  .object({
    symbol: text(20),
    name: text(100),
    dimension: z.enum(UNIT_DIMENSIONS),
    uneceCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,3}$/, 'UN/ECE-Code mit 2–3 Zeichen, z. B. H87.'),
    decimals: z.number().int().min(0).max(4),
    isActive: z.boolean(),
  })
  .partial()

export interface UnitSetting {
  id: string
  symbol: string
  name: string
  dimension: string
  uneceCode: string
  decimals: number
  isSystem: boolean
  isActive: boolean
}

// ---- Arbeitszeiten -------------------------------------------------------------------------

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit als HH:MM.')
  .nullable()

export const workingHoursRequest = z.array(
  z.object({
    weekday: z.number().int().min(1).max(7),
    startTime: time,
    endTime: time,
    breakMinutes: z.number().int().min(0).max(240),
  }),
)

export interface WorkingDay {
  weekday: number
  startTime: string | null
  endTime: string | null
  breakMinutes: number
}

// ---- Textvorlagen, Ablage ----------------------------------------------------------------------

export const textTemplateRequest = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES),
    placement: z.enum(['intro', 'closing']),
    name: text(100),
    body: z.string().trim().min(1, 'Darf nicht leer sein.').max(10_000),
    isDefault: z.boolean(),
  })
  .partial()

export interface TextTemplate {
  id: string
  documentType: string
  placement: 'intro' | 'closing'
  name: string
  body: string
  isDefault: boolean
}

export const filingTemplateRequest = z.object({
  folders: z.array(text(100)).max(50),
})

// ---- DATEV ------------------------------------------------------------------------------------

export const datevSettingsRequest = z.object({
  consultantNumber: z
    .string()
    .regex(/^\d{4,7}$/, 'Beraternummer: 4–7 Ziffern.')
    .nullable(),
  clientNumber: z
    .string()
    .regex(/^\d{1,5}$/, 'Mandantennummer: 1–5 Ziffern.')
    .nullable(),
  chart: z.enum(['SKR03', 'SKR04']),
  /** First month of the fiscal year (1 = January). */
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  accountLength: z.number().int().min(4).max(8),
  /** Erlöskonten; empty = defaults of the chart. */
  revenueAccounts: z
    .object({
      standard19: z
        .string()
        .regex(/^\d{4,8}$/)
        .nullable(),
      reduced7: z
        .string()
        .regex(/^\d{4,8}$/)
        .nullable(),
      reverseCharge: z
        .string()
        .regex(/^\d{4,8}$/)
        .nullable(),
      exempt: z
        .string()
        .regex(/^\d{4,8}$/)
        .nullable(),
    })
    .partial(),
  bankAccount: z
    .string()
    .regex(/^\d{4,8}$/)
    .nullable(),
})
export type DatevSettings = z.infer<typeof datevSettingsRequest>

export const settingsIdParam = z.object({ id })

// ---- Betrieb (Betriebs-Check) -------------------------------------------------------------------

export interface BackupRunSummary {
  name: string
  status: 'ok' | 'failed'
  startedAt: string
  finishedAt: string
  dbBytes: number | null
  filesBytes: number | null
  message: string | null
}

export interface OperationsStatus {
  backup: {
    /** Newest successful backup; the check warns if it is older than 26 hours. */
    lastSuccess: BackupRunSummary | null
    recent: BackupRunSummary[]
  }
  email: { enabled: boolean; queued: number; failed: number }
  security: { requireAdminMfa: boolean; https: boolean }
  /** Audit-Kette (rule 6): newest check of the hash chain; stale = older than 26 hours. */
  audit: {
    lastCheckAt: string | null
    problem: 'broken' | 'truncated' | 'rewritten' | null
    brokenSeq: number | null
    events: number
    stale: boolean
  }
  /** KoSIT validator (ADR 0007): without it no invoice can be finalized (rule 8). */
  einvoice: { configured: boolean; reachable: boolean }
  /** Revisionssicheres Belegarchiv (ADR 0008, S3 with Object Lock). */
  archive: {
    configured: boolean
    bucket: string | null
    reachable: boolean
    objectLock: boolean
    mode: 'COMPLIANCE' | 'GOVERNANCE' | null
    /** Originals not yet in the WORM bucket; the oldest one; those that failed at least once. */
    pending: number
    oldestPendingAt: string | null
    failing: number
    lastError: string | null
  }
}
