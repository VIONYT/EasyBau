import { z } from 'zod'
import { email, isoDate, optionalText } from './common.js'

/**
 * Mahnwesen (DESIGN.md §2, §4.6): Zahlungserinnerung → 1. Mahnung → letzte Mahnung. Fees and
 * Verzugszinsen are claimed in the letter only (no VAT, no change of the invoice).
 */
export const DUNNING_LEVELS = ['reminder', 'first', 'final'] as const
export type DunningLevel = (typeof DUNNING_LEVELS)[number]

/** Placeholders of the letter text: {Rechnung}, {Rechnungsdatum}, {Frist}, {Betrag}. */
const levelRule = z.object({
  days: z
    .number()
    .int('Ganze Tage erwartet.')
    .min(1, 'Mindestens 1 Tag.')
    .max(90, 'Höchstens 90 Tage.'),
  feeCents: z
    .number()
    .int('Betrag in Cent erwartet.')
    .min(0, 'Die Gebühr darf nicht negativ sein.')
    .max(100_000, 'Die Gebühr ist zu hoch.'),
  interest: z.boolean(),
  text: z.string().trim().min(1, 'Bitte einen Text eingeben.').max(2000, 'Höchstens 2000 Zeichen.'),
})
export type DunningLevelSettings = z.infer<typeof levelRule>

export const dunningSettingsRequest = z.object({
  reminder: levelRule,
  first: levelRule,
  final: levelRule,
  /** Claim the Verzugspauschale of 40 € from business customers (§ 288 Abs. 5 BGB). */
  flatFeeBusiness: z.boolean(),
})
export type DunningSettings = z.infer<typeof dunningSettingsRequest>

export const DEFAULT_DUNNING_SETTINGS: DunningSettings = {
  reminder: {
    days: 10,
    feeCents: 0,
    interest: false,
    text: 'sicher ist es Ihrer Aufmerksamkeit entgangen: Unsere Rechnung {Rechnung} vom {Rechnungsdatum} ist noch offen. Bitte überweisen Sie den Betrag von {Betrag} bis zum {Frist}. Sollten Sie inzwischen gezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.',
  },
  first: {
    days: 7,
    feeCents: 500,
    interest: true,
    text: 'trotz unserer Zahlungserinnerung ist die Rechnung {Rechnung} vom {Rechnungsdatum} noch nicht beglichen. Bitte überweisen Sie den unten aufgeführten Gesamtbetrag von {Betrag} bis spätestens {Frist}.',
  },
  final: {
    days: 7,
    feeCents: 1000,
    interest: true,
    text: 'leider haben Sie auch auf unsere Mahnung nicht reagiert. Wir fordern Sie letztmalig auf, den Gesamtbetrag von {Betrag} für die Rechnung {Rechnung} vom {Rechnungsdatum} bis zum {Frist} zu zahlen. Nach Ablauf der Frist werden wir die Forderung ohne weitere Ankündigung gerichtlich geltend machen.',
  },
  flatFeeBusiness: false,
}

/** Values of one notice; omitted ones come from the settings. */
export const createDunningRequest = z.object({
  noticeDate: isoDate.optional(),
  days: z.number().int().min(1, 'Mindestens 1 Tag.').max(90, 'Höchstens 90 Tage.').optional(),
  feeCents: z
    .number()
    .int('Betrag in Cent erwartet.')
    .min(0, 'Die Gebühr darf nicht negativ sein.')
    .max(100_000, 'Die Gebühr ist zu hoch.')
    .optional(),
  interest: z.boolean().optional(),
  /** First day of Verzug (interest start). */
  interestFrom: isoDate.nullish(),
  business: z.boolean().optional(),
  flatFee: z.boolean().optional(),
  text: optionalText(2000),
  /** Send by e-mail with the PDF attached (needs SMTP). */
  email: z
    .object({
      to: email,
      message: optionalText(4000),
    })
    .nullish(),
})
export type CreateDunningRequest = z.infer<typeof createDunningRequest>

export const sendDunningRequest = z.object({ to: email, message: optionalText(4000) })

export interface DunningAmounts {
  level: DunningLevel
  noticeDate: string
  dueDate: string
  days: number
  business: boolean
  interest: boolean
  /** Offene Forderung of the invoice on the notice date. */
  openCents: number
  feeCents: number
  flatFeeCents: number
  interestCents: number
  interestRatePercent: string
  interestFrom: string | null
  interestTo: string | null
  /** Interest per base-rate period. */
  segments: {
    from: string
    to: string
    days: number
    ratePercent: string
    /** Amount owed in this period (lower after payments). */
    principalCents: number
  }[]
  /** Fees and Pauschale of earlier notices, still claimed. */
  earlierChargesCents: number
  totalCents: number
  text: string
}

export interface DunningNotice
  extends Omit<DunningAmounts, 'segments' | 'text' | 'days' | 'interest'> {
  id: string
  createdAt: string
  createdBy: string | null
  /** Last e-mail of this notice. */
  email: {
    to: string
    status: 'queued' | 'sending' | 'sent' | 'failed'
    sentAt: string | null
  } | null
}

export interface DunningOverview {
  notices: DunningNotice[]
  /** Preview of the next level with the settings, or null. */
  next: DunningAmounts | null
  /** Why no further notice is possible right now (German), or null. */
  blocked: string | null
  emailEnabled: boolean
  /** E-mail address of the customer (primary e-mail or e-invoice address). */
  suggestedEmail: string | null
}

export const baseInterestRateRequest = z.object({
  validFrom: isoDate,
  ratePercent: z
    .string()
    .trim()
    .regex(/^-?\d{1,2}([.,]\d{1,2})?$/, 'Zinssatz wie 1,52 oder -0,88 erwartet.')
    .transform((v) => v.replace(',', '.')),
})

export interface BaseInterestRate {
  id: string
  validFrom: string
  ratePercent: string
  /** Added by this company (can be removed); otherwise shipped with the release. */
  own: boolean
}
