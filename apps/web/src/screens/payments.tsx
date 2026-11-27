import { settlementSuggestion } from '@easybau/domain'
import type {
  AdjustmentKind,
  DocumentDetail,
  PaymentMethod,
  Receivable,
  ReceivableStatus,
} from '@easybau/schemas'
import { Button, MoneyField } from '@easybau/ui'
import { useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { centsToInput, formatCents, formatDateTime, parseEuro } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'

const ADJUSTMENT_KINDS: AdjustmentKind[] = [
  'short_payment',
  'cash_discount',
  'retention',
  'construction_levy',
  'bank_fee',
  'other',
]
const METHODS: PaymentMethod[] = ['transfer', 'cash', 'card', 'direct_debit', 'other']

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())
const date = (iso: string | null) => (iso ? formatDateTime(iso, 'date') : '–')

export function ReceivableChip({ status }: { status: ReceivableStatus | 'draft' }) {
  return <span className={`chip chip--pay-${status}`}>{t(`pay.status.${status}` as TextKey)}</span>
}

type Mode = null | 'payment' | 'adjustment' | 'release'

/** Zahlungen & Forderung of a finalized invoice (no bookkeeping: entries per invoice only). */
export function ReceivablePanel({
  doc,
  canWrite,
  onChange,
}: {
  doc: DocumentDetail
  canWrite: boolean
  onChange: (receivable: Receivable) => void
}) {
  const r = doc.receivable as Receivable
  const headingId = useId()
  const [mode, setMode] = useState<Mode>(null)
  const [error, setError] = useState<string | null>(null)
  const closed = r.status === 'cancelled' || doc.invoiceKind === 'cancellation'

  const send = async (path: string, body: unknown) => {
    setError(null)
    try {
      const result = await api<{ receivable: Receivable }>('POST', path, body)
      onChange(result.receivable)
      setMode(null)
    } catch (err) {
      const e = err as ApiError
      setError([e.message, ...Object.values(e.fieldErrors)].join(' '))
    }
  }
  const reverse = async (kind: 'payments' | 'adjustments', id: string) => {
    const reason = window.prompt(t('pay.reverseReason'))
    if (reason === null) return
    await send(`/api/v1/${kind}/${id}/reverse`, { reason: reason.trim() || undefined })
  }
  const toggleDisputed = async (id: string, disputed: boolean) => {
    setError(null)
    try {
      onChange(
        (await api<{ receivable: Receivable }>('PATCH', `/api/v1/adjustments/${id}`, { disputed }))
          .receivable,
      )
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  const rows: [string, number | string, boolean?][] = [
    [t('pay.gross'), formatCents(r.grossCents)],
    ...(r.payableCents !== r.grossCents
      ? ([[t('pay.payable'), formatCents(r.payableCents)]] as [string, string][])
      : []),
    [t('pay.paid'), formatCents(r.paidCents)],
    ...(r.adjustedCents
      ? ([[t('pay.adjusted'), formatCents(r.adjustedCents)]] as [string, string][])
      : []),
    [t('pay.open'), formatCents(r.openCents), true],
    ...(r.creditCents
      ? ([[t('pay.credit'), formatCents(r.creditCents)]] as [string, string][])
      : []),
    ...(r.retentionHeldCents
      ? ([[t('pay.retentionHeld'), formatCents(r.retentionHeldCents)]] as [string, string][])
      : []),
  ]

  return (
    <section className="panel receivable" aria-labelledby={headingId}>
      <div className="panel-head">
        <h2 id={headingId}>{t('pay.title')}</h2>
        <ReceivableChip status={r.status} />
      </div>
      <dl className="receivable-sums">
        {rows.map(([label, value, strong]) => (
          <div key={label} className={strong ? 'is-strong' : undefined}>
            <dt>{label}</dt>
            <dd className="amount">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">
        {tf('pay.due', { date: date(r.dueDate) })}
        {r.overdueDays ? ` ${tf('pay.overdueDays', { n: String(r.overdueDays) })}` : ''}
        {r.cashDiscount
          ? ` ${tf('pay.cashDiscount', {
              percent: r.cashDiscount.percent.replace('.', ','),
              until: date(r.cashDiscount.until),
              amount: formatCents(r.cashDiscount.amountCents),
            })}`
          : ''}
      </p>

      {r.payments.length || r.adjustments.length ? (
        <ul className="list entries">
          {r.payments.map((p) => (
            <li key={p.id} className={p.reversedById || p.reversesId ? 'is-reversed' : undefined}>
              <span>
                <strong className="amount">{formatCents(p.amountCents)}</strong>{' '}
                {tf('pay.paymentLine', {
                  date: date(p.paidOn),
                  method: t(`pay.method.${p.method}` as TextKey),
                })}
                {p.reference ? <span className="muted"> · {p.reference}</span> : null}
              </span>
              {canWrite && !p.reversedById && !p.reversesId ? (
                <Button type="button" variant="ghost" onClick={() => reverse('payments', p.id)}>
                  {t('pay.reverse')}
                </Button>
              ) : null}
            </li>
          ))}
          {r.adjustments.map((a) => (
            <li key={a.id} className={a.reversedById || a.reversesId ? 'is-reversed' : undefined}>
              <span>
                <strong className="amount">{formatCents(a.amountCents)}</strong>{' '}
                {t(`pay.kind.${a.kind}` as TextKey)}
                {a.reason ? <span className="muted"> · {a.reason}</span> : null}
                {a.disputed ? (
                  <span className="chip chip--pay-overdue">{t('pay.disputed')}</span>
                ) : null}
              </span>
              {canWrite && !a.reversedById && !a.reversesId ? (
                <span className="entry-actions">
                  {a.kind === 'short_payment' || a.kind === 'other' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => toggleDisputed(a.id, !a.disputed)}
                    >
                      {a.disputed ? t('pay.accept') : t('pay.dispute')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => reverse('adjustments', a.id)}
                  >
                    {t('pay.reverse')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('pay.none')}</p>
      )}

      <FormError>{error}</FormError>
      {canWrite && !closed && mode === null ? (
        <div className="actions start">
          {r.openCents > 0 ? (
            <Button type="button" variant="primary" onClick={() => setMode('payment')}>
              {t('pay.record')}
            </Button>
          ) : null}
          {r.openCents > 0 ? (
            <Button type="button" variant="ghost" onClick={() => setMode('adjustment')}>
              {t('pay.recordAdjustment')}
            </Button>
          ) : null}
          {r.retentionHeldCents > 0 ? (
            <Button type="button" variant="ghost" onClick={() => setMode('release')}>
              {t('pay.release')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {mode === 'payment' ? (
        <PaymentForm
          doc={doc}
          onCancel={() => setMode(null)}
          onSubmit={(body) => send(`/api/v1/documents/${doc.id}/payments`, body)}
        />
      ) : null}
      {mode === 'adjustment' ? (
        <AdjustmentForm
          onCancel={() => setMode(null)}
          onSubmit={(body) => send(`/api/v1/documents/${doc.id}/adjustments`, body)}
        />
      ) : null}
      {mode === 'release' ? (
        <ReleaseForm
          max={r.retentionHeldCents}
          onCancel={() => setMode(null)}
          onSubmit={(body) => send(`/api/v1/documents/${doc.id}/retention-release`, body)}
        />
      ) : null}
    </section>
  )
}

function Buttons({ onCancel, disabled }: { onCancel: () => void; disabled: boolean }) {
  return (
    <div className="button-row">
      <Button type="submit" variant="primary" disabled={disabled}>
        {t('common.save')}
      </Button>
      <Button type="button" variant="ghost" width="natural" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </div>
  )
}

function PaymentForm({
  doc,
  onSubmit,
  onCancel,
}: {
  doc: DocumentDetail
  onSubmit: (body: unknown) => Promise<void>
  onCancel: () => void
}) {
  const r = doc.receivable as Receivable
  const id = useId()
  const [paidOn, setPaidOn] = useState(today)
  const [amount, setAmount] = useState(centsToInput(r.openCents))
  const [method, setMethod] = useState<PaymentMethod>('transfer')
  const [reference, setReference] = useState('')
  const [settle, setSettle] = useState(true)
  const [busy, setBusy] = useState(false)
  const cents = parseEuro(amount)
  const valid = cents !== null && Number.isFinite(cents) && cents > 0
  const suggestion = valid
    ? settlementSuggestion({
        openCents: BigInt(r.openCents),
        amountCents: BigInt(cents as number),
        paidOn,
        documentDate: doc.documentDate,
        cashDiscountPercent: r.cashDiscount?.percent ?? null,
        cashDiscountDays: r.cashDiscount?.days ?? null,
        payableCents: BigInt(r.payableCents),
        retentionCents: BigInt(r.retentionCents),
        constructionLevyCents: BigInt(r.constructionLevyCents),
        adjustments: r.adjustments.map((a) => ({
          kind: a.kind,
          amountCents: BigInt(a.amountCents),
        })),
      })
    : []
  const rest = valid ? r.openCents - (cents as number) : 0
  return (
    <form
      className="stack inline-form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        setBusy(true)
        await onSubmit({
          paidOn,
          amountCents: cents,
          method,
          reference: reference.trim() || undefined,
          settle: settle
            ? suggestion.map((s) => ({ kind: s.kind, amountCents: Number(s.amountCents) }))
            : [],
        })
        setBusy(false)
      }}
    >
      <h3>{t('pay.record')}</h3>
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-date`}>{t('pay.paidOn')}</label>
          <input
            id={`${id}-date`}
            type="date"
            value={paidOn}
            max={today()}
            onChange={(e) => setPaidOn(e.target.value)}
          />
        </div>
        <MoneyField
          label={t('pay.amount')}
          name="amount"
          invalidText={t('doc.invalidAmount')}
          value={amount}
          onChange={setAmount}
          invalid={!valid}
        />
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-method`}>{t('pay.method')}</label>
          <select
            id={`${id}-method`}
            className="select"
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`pay.method.${m}` as TextKey)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-ref`}>{t('pay.reference')}</label>
          <input
            id={`${id}-ref`}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      </div>
      {suggestion.length ? (
        <label className="check">
          <input type="checkbox" checked={settle} onChange={(e) => setSettle(e.target.checked)} />
          <span>
            {tf('pay.settle', {
              items: suggestion
                .map(
                  (s) =>
                    `${t(`pay.kind.${s.kind}` as TextKey)} ${formatCents(Number(s.amountCents))}`,
                )
                .join(', '),
            })}
          </span>
        </label>
      ) : rest > 0 ? (
        <p className="hint">{tf('pay.partial', { rest: formatCents(rest) })}</p>
      ) : rest < 0 ? (
        <p className="hint">{tf('pay.overpaid', { amount: formatCents(-rest) })}</p>
      ) : null}
      <Buttons onCancel={onCancel} disabled={busy || !valid} />
    </form>
  )
}

function AdjustmentForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: unknown) => Promise<void>
  onCancel: () => void
}) {
  const id = useId()
  const [kind, setKind] = useState<AdjustmentKind>('short_payment')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [disputed, setDisputed] = useState(true)
  const [busy, setBusy] = useState(false)
  const cents = parseEuro(amount)
  const valid = cents !== null && Number.isFinite(cents) && cents > 0
  const isCut = kind === 'short_payment' || kind === 'other'
  return (
    <form
      className="stack inline-form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        setBusy(true)
        await onSubmit({
          kind,
          amountCents: cents,
          reason: reason.trim() || undefined,
          disputed: isCut && disputed,
        })
        setBusy(false)
      }}
    >
      <h3>{t('pay.recordAdjustment')}</h3>
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-kind`}>{t('pay.kind')}</label>
          <select
            id={`${id}-kind`}
            className="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as AdjustmentKind)}
          >
            {ADJUSTMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`pay.kind.${k}` as TextKey)}
              </option>
            ))}
          </select>
        </div>
        <MoneyField
          label={t('pay.amount')}
          name="amount"
          invalidText={t('doc.invalidAmount')}
          value={amount}
          onChange={setAmount}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-reason`}>
          {t('pay.reason')}
          {isCut ? <span aria-hidden="true"> *</span> : null}
        </label>
        <input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {isCut ? (
        <label className="check">
          <input
            type="checkbox"
            checked={disputed}
            onChange={(e) => setDisputed(e.target.checked)}
          />
          <span>{t('pay.disputedHint')}</span>
        </label>
      ) : null}
      <Buttons onCancel={onCancel} disabled={busy || !valid || (isCut && !reason.trim())} />
    </form>
  )
}

function ReleaseForm({
  max,
  onSubmit,
  onCancel,
}: {
  max: number
  onSubmit: (body: unknown) => Promise<void>
  onCancel: () => void
}) {
  const id = useId()
  const [paidOn, setPaidOn] = useState(today)
  const [amount, setAmount] = useState(centsToInput(max))
  const [busy, setBusy] = useState(false)
  const cents = parseEuro(amount)
  const valid = cents !== null && Number.isFinite(cents) && cents > 0 && cents <= max
  return (
    <form
      className="stack inline-form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        setBusy(true)
        await onSubmit({ paidOn, amountCents: cents })
        setBusy(false)
      }}
    >
      <h3>{t('pay.release')}</h3>
      <p className="hint">{t('pay.releaseHint')}</p>
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-date`}>{t('pay.paidOn')}</label>
          <input
            id={`${id}-date`}
            type="date"
            value={paidOn}
            max={today()}
            onChange={(e) => setPaidOn(e.target.value)}
          />
        </div>
        <MoneyField
          label={t('pay.amount')}
          name="amount"
          invalidText={t('doc.invalidAmount')}
          value={amount}
          onChange={setAmount}
        />
      </div>
      <Buttons onCancel={onCancel} disabled={busy || !valid} />
    </form>
  )
}
