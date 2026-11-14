import { z } from 'zod'
import { id, isoDate, listQuery, optionalText } from './common.js'
import type { DocumentType, InvoiceKind } from './documents.js'

/**
 * Zahlungen & Forderungen (DESIGN.md §4.6): payments and deductions per invoice, open amount,
 * status, invoice list. No bookkeeping (no accounts, no journal).
 */
export const RECEIVABLE_STATUSES = [
  'open',
  'partially_paid',
  'paid',
  'overdue',
  'dunned',
  'cancelled',
] as const
export type ReceivableStatus = (typeof RECEIVABLE_STATUSES)[number]

export const ADJUSTMENT_KINDS = [
  'cash_discount',
  'retention',
  'construction_levy',
  'bank_fee',
  'short_payment',
  'other',
] as const
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number]

export const PAYMENT_METHODS = ['transfer', 'cash', 'card', 'direct_debit', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

/** Amounts in cents; at most 100 million euros per entry. */
const cents = z
  .number('Betrag fehlt.')
  .int('Betrag in Cent erwartet.')
  .positive('Der Betrag muss größer als 0 sein.')
  .max(10_000_000_000, 'Der Betrag ist zu groß.')

const needsReason = (kind: AdjustmentKind) => kind === 'short_payment' || kind === 'other'

export const recordPaymentRequest = z.object({
  paidOn: isoDate,
  amountCents: cents,
  method: z.enum(PAYMENT_METHODS).default('transfer'),
  reference: optionalText(200),
  /** Deductions that settle the rest at the same time (Skonto, Einbehalt, Bauumlage …). */
  settle: z
    .array(z.object({ kind: z.enum(ADJUSTMENT_KINDS), amountCents: cents }))
    .max(6)
    .default([]),
})
export type RecordPaymentRequest = z.infer<typeof recordPaymentRequest>

export const recordAdjustmentRequest = z
  .object({
    kind: z.enum(ADJUSTMENT_KINDS, 'Unbekannte Art des Abzugs.'),
    amountCents: cents,
    reason: optionalText(500),
    /** Kürzung: the company does not accept it (stays visible as disputed). */
    disputed: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (needsReason(value.kind) && !value.reason) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Bitte einen Grund angeben.' })
    }
  })
export type RecordAdjustmentRequest = z.infer<typeof recordAdjustmentRequest>

/** Sicherheitseinbehalt paid out later: payment plus release of the withheld amount. */
export const releaseRetentionRequest = z.object({
  paidOn: isoDate,
  amountCents: cents,
  method: z.enum(PAYMENT_METHODS).default('transfer'),
})

export const reverseEntryRequest = z.object({ reason: optionalText(500) })

export const updateAdjustmentRequest = z.object({ disputed: z.boolean() })

export interface PaymentEntry {
  id: string
  paidOn: string
  amountCents: number
  method: PaymentMethod
  reference: string | null
  /** This entry reverses another one (Gegenbuchung). */
  reversesId: string | null
  /** Reversed by this entry. */
  reversedById: string | null
  createdAt: string
  createdBy: string | null
}

export interface AdjustmentEntry {
  id: string
  kind: AdjustmentKind
  amountCents: number
  reason: string | null
  disputed: boolean
  reversesId: string | null
  reversedById: string | null
  createdAt: string
  createdBy: string | null
}

export interface Receivable {
  status: ReceivableStatus
  grossCents: number
  /** Zahlbetrag laut Rechnung (gross − Einbehalt − Bauumlage). */
  payableCents: number
  paidCents: number
  adjustedCents: number
  openCents: number
  /** Overpayment (Guthaben). */
  creditCents: number
  retentionHeldCents: number
  dueDate: string | null
  overdueDays: number
  /** Skonto conditions of the invoice. */
  cashDiscount: { percent: string; days: number; until: string; amountCents: number } | null
  /** Planned on the invoice, for the settlement suggestion. */
  retentionCents: number
  constructionLevyCents: number
  payments: PaymentEntry[]
  adjustments: AdjustmentEntry[]
}

export const invoiceListQuery = listQuery.extend({
  status: z.enum([...RECEIVABLE_STATUSES, 'draft']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  projectId: id.optional(),
  /** Only invoices with a Sicherheitseinbehalt (planned or withheld). */
  retention: z.enum(['true', 'false']).optional(),
  /** Mahnvorschläge: only invoices whose next Mahnstufe can be issued today. */
  dunning: z.enum(['due']).optional(),
})
export type InvoiceListQuery = z.infer<typeof invoiceListQuery>

export interface InvoiceListItem {
  id: string
  type: Extract<DocumentType, 'invoice' | 'credit_note'>
  invoiceKind: InvoiceKind | null
  progressNo: number | null
  number: string | null
  subject: string | null
  documentDate: string
  dueDate: string | null
  recipient: string | null
  project: { id: string; number: string | null; name: string }
  netCents: number
  grossCents: number
  paidCents: number
  adjustedCents: number
  openCents: number
  retentionHeldCents: number
  /** Drafts are listed with status "draft" and count in no sum. */
  status: ReceivableStatus | 'draft'
  overdueDays: number
  hasEinvoice: boolean
  /** Last issued Mahnstufe. */
  dunningLevel: 'reminder' | 'first' | 'final' | null
  /** Next Mahnstufe and from when it can be issued (due = today, Mahnvorschlag). */
  nextDunning: { level: 'reminder' | 'first' | 'final'; possibleFrom: string; due: boolean } | null
}

export interface InvoiceList {
  items: InvoiceListItem[]
  /** Over all invoices of the filter (not only this page); drafts and cancelled ones excluded. */
  sums: {
    count: number
    netCents: number
    grossCents: number
    paidCents: number
    openCents: number
    overdueCents: number
  }
  nextCursor: string | null
}
