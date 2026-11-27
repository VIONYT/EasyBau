import type { Tx } from '@easybau/db'
import { addDays, receivableState } from '@easybau/domain'
import type { AdjustmentEntry, DocumentDetail, PaymentEntry, Receivable } from '@easybau/schemas'
import { servicesOf } from '../context.js'

/**
 * Forderung einer Rechnung (payments, deductions, open amount) and "today" of the company. Kept
 * apart from routes/receivables.ts so that loading a document does not import the payment routes.
 */

export const ISO = (tx: Tx, column: string) =>
  tx.unsafe(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)

/** Today in Germany (due dates are calendar days of the company). */
export function todayIn(now: number, timeZone = 'Europe/Berlin'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(now))
}

export const isBilled = (doc: Pick<DocumentDetail, 'type'>) =>
  doc.type === 'invoice' || doc.type === 'credit_note'

/** Payments, deductions, open amount and status of a finalized invoice or credit note. */
export async function loadReceivable(
  tx: Tx,
  doc: DocumentDetail,
  today: string,
): Promise<Receivable | null> {
  if (!isBilled(doc) || !doc.finalizedAt) return null
  const payments = await tx<(Omit<PaymentEntry, 'amountCents'> & { amount: string })[]>`
    select p.id, to_char(p.paid_on, 'YYYY-MM-DD') as "paidOn", p.amount_cents::text as amount, p.method,
           p.reference, p.reverses_payment_id as "reversesId",
           (select r.id from payment r where r.reverses_payment_id = p.id) as "reversedById",
           ${ISO(tx, 'p.created_at')} as "createdAt", u.display_name as "createdBy"
    from payment p left join app_user u on u.id = p.created_by
    where p.invoice_id = ${doc.id} order by p.paid_on, p.created_at`
  const adjustments = await tx<(Omit<AdjustmentEntry, 'amountCents'> & { amount: string })[]>`
    select a.id, a.kind, a.amount_cents::text as amount, a.reason, a.disputed,
           a.reverses_adjustment_id as "reversesId",
           (select r.id from receivable_adjustment r where r.reverses_adjustment_id = a.id) as "reversedById",
           ${ISO(tx, 'a.created_at')} as "createdAt", u.display_name as "createdBy"
    from receivable_adjustment a left join app_user u on u.id = a.created_by
    where a.invoice_id = ${doc.id} order by a.created_at`
  const [dunning] = await tx<{ dunned: boolean }[]>`
    select exists (select 1 from dunning_notice where invoice_id = ${doc.id} and sent_at is not null) as dunned`
  const state = receivableState({
    grossCents: BigInt(doc.totals.grossCents),
    paidCents: payments.reduce((s, p) => s + BigInt(p.amount), 0n),
    adjustments: adjustments.map((a) => ({ kind: a.kind, amountCents: BigInt(a.amount) })),
    dueDate: doc.dueDate,
    today,
    cancelled: doc.status === 'cancelled' || doc.invoiceKind === 'cancellation',
    dunned: dunning?.dunned ?? false,
  })
  const n = (v: bigint) => Number(v)
  return {
    status: state.status,
    grossCents: doc.totals.grossCents,
    payableCents: doc.totals.payableCents,
    paidCents: n(payments.reduce((s, p) => s + BigInt(p.amount), 0n)),
    adjustedCents: n(state.adjustedCents),
    openCents: n(state.openCents),
    creditCents: n(state.creditCents),
    retentionHeldCents: n(state.retentionHeldCents),
    dueDate: doc.dueDate,
    overdueDays: state.overdueDays,
    cashDiscount:
      doc.cashDiscountPercent && doc.cashDiscountDays !== null
        ? {
            percent: doc.cashDiscountPercent,
            days: doc.cashDiscountDays,
            until: addDays(doc.documentDate, doc.cashDiscountDays),
            amountCents: doc.totals.cashDiscountCents,
          }
        : null,
    retentionCents: doc.totals.retentionCents,
    constructionLevyCents: doc.totals.constructionLevyCents,
    payments: payments.map(({ amount, ...p }) => ({ ...p, amountCents: Number(amount) })),
    adjustments: adjustments.map(({ amount, ...a }) => ({ ...a, amountCents: Number(amount) })),
  }
}

/** Today for the current request (injectable clock of the services). */
export const todayOf = (tx: Tx) => todayIn(servicesOf(tx)?.now() ?? Date.now())
