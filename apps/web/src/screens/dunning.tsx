import type {
  CreateDunningRequest,
  DocumentDetail,
  DunningAmounts,
  DunningLevel,
  DunningNotice,
  DunningOverview,
} from '@easybau/schemas'
import { Button, buttonClass, MoneyField } from '@easybau/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { centsToInput, formatCents, formatDateTime, parseEuro } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'

const date = (iso: string | null) => (iso ? formatDateTime(iso, 'date') : '–')
const percent = (value: string) => value.replace(/\.?0+$/, '').replace('.', ',')
const levelLabel = (level: DunningLevel) => t(`dun.level.${level}` as TextKey)

const problem = (err: unknown) => {
  const e = err as ApiError
  return [e.message, ...Object.values(e.fieldErrors ?? {})].join(' ')
}

/**
 * Mahnwesen of a finalized invoice: Zahlungserinnerung → 1. Mahnung → letzte Mahnung. Every notice
 * is issued once (PDF/A archived) and can be sent by e-mail; nothing here changes the invoice.
 */
export function DunningPanel({
  doc,
  canWrite,
  onIssued,
}: {
  doc: DocumentDetail
  canWrite: boolean
  onIssued: () => void
}) {
  const headingId = useId()
  const [overview, setOverview] = useState<DunningOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [mailing, setMailing] = useState<string | null>(null)

  const load = useCallback(() => {
    api<DunningOverview>('GET', `/api/v1/documents/${doc.id}/dunning`)
      .then(setOverview)
      .catch((err) => setError(problem(err)))
  }, [doc.id])
  // Reload when payments change the open amount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the receivable is the trigger
  useEffect(load, [load, doc.receivable?.openCents])

  if (!overview) return null
  const { notices, next } = overview
  if (!notices.length && !next && !overview.blocked) return null

  return (
    <section className="panel dunning" aria-labelledby={headingId}>
      <div className="panel-head">
        <h2 id={headingId}>{t('dun.title')}</h2>
      </div>
      {notices.length ? (
        <ul className="list entries">
          {notices.map((n) => (
            <NoticeRow
              key={n.id}
              notice={n}
              canMail={canWrite && overview.emailEnabled}
              mailing={mailing === n.id}
              onMail={() => setMailing(mailing === n.id ? null : n.id)}
              suggestedEmail={overview.suggestedEmail}
              onSent={() => {
                setMailing(null)
                load()
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="muted">{t('dun.none')}</p>
      )}
      <FormError>{error}</FormError>
      {next && !creating ? (
        <div className="actions start">
          <p className="hint">
            {tf('dun.nextHint', {
              level: levelLabel(next.level),
              total: formatCents(next.totalCents),
            })}
          </p>
          {canWrite ? (
            <Button type="button" variant="primary" onClick={() => setCreating(true)}>
              {tf('dun.create', { level: levelLabel(next.level) })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!next && overview.blocked && doc.receivable?.openCents ? (
        <p className="hint">{overview.blocked}</p>
      ) : null}
      {next && creating ? (
        <DunningForm
          doc={doc}
          initial={next}
          emailEnabled={overview.emailEnabled}
          suggestedEmail={overview.suggestedEmail}
          onCancel={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            load()
            onIssued()
          }}
        />
      ) : null}
    </section>
  )
}

function NoticeRow({
  notice: n,
  canMail,
  mailing,
  onMail,
  suggestedEmail,
  onSent,
}: {
  notice: DunningNotice
  canMail: boolean
  mailing: boolean
  onMail: () => void
  suggestedEmail: string | null
  onSent: () => void
}) {
  const id = useId()
  const [to, setTo] = useState(n.email?.to ?? suggestedEmail ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('POST', `/api/v1/dunning-notices/${n.id}/email`, { to })
      onSent()
    } catch (err) {
      setError(problem(err))
    } finally {
      setBusy(false)
    }
  }
  const charges = n.feeCents + n.flatFeeCents + n.interestCents
  return (
    <li className="dunning-notice">
      <span>
        <strong>{levelLabel(n.level)}</strong>{' '}
        {tf('dun.noticeLine', { date: date(n.noticeDate), due: date(n.dueDate) })}
        <br />
        <span className="amount">{formatCents(n.totalCents)}</span>
        {charges ? (
          <span className="muted"> · {tf('dun.charges', { amount: formatCents(charges) })}</span>
        ) : null}
        {n.email ? (
          <span className={`chip chip--mail-${n.email.status}`}>
            {tf(`dun.mail.${n.email.status}` as TextKey, { to: n.email.to })}
          </span>
        ) : null}
      </span>
      <span className="entry-actions">
        <a
          className={buttonClass({ variant: 'ghost' })}
          href={`/api/v1/dunning-notices/${n.id}/pdf`}
          target="_blank"
          rel="noopener"
        >
          {t('dun.pdf')}
        </a>
        {canMail ? (
          <Button type="button" variant="ghost" onClick={onMail}>
            {t('dun.sendMail')}
          </Button>
        ) : null}
      </span>
      {mailing ? (
        <form className="form inline-form" onSubmit={send}>
          <div className="field">
            <label htmlFor={`${id}-to`}>{t('dun.mailTo')}</label>
            <input
              id={`${id}-to`}
              type="email"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <FormError>{error}</FormError>
          <div className="button-row">
            <Button type="submit" variant="primary" disabled={busy}>
              {t('dun.sendMail')}
            </Button>
            <Button type="button" variant="ghost" width="natural" onClick={onMail}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  )
}

function DunningForm({
  doc,
  initial,
  emailEnabled,
  suggestedEmail,
  onCancel,
  onDone,
}: {
  doc: DocumentDetail
  initial: DunningAmounts
  emailEnabled: boolean
  suggestedEmail: string | null
  onCancel: () => void
  onDone: () => void
}) {
  const id = useId()
  const [noticeDate, setNoticeDate] = useState(initial.noticeDate)
  const [days, setDays] = useState(String(initial.days))
  const [fee, setFee] = useState(centsToInput(initial.feeCents))
  const [interest, setInterest] = useState(initial.interest)
  const [interestFrom, setInterestFrom] = useState(initial.interestFrom ?? '')
  const [business, setBusiness] = useState(initial.business)
  const [flatFee, setFlatFee] = useState(initial.flatFeeCents > 0)
  const [text, setText] = useState(initial.text)
  // Until edited, the text follows the preview (amount and deadline filled in by the server).
  const [textEdited, setTextEdited] = useState(false)
  const [mail, setMail] = useState(emailEnabled && Boolean(suggestedEmail))
  const [to, setTo] = useState(suggestedEmail ?? '')
  const [preview, setPreview] = useState<DunningAmounts>(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const feeCents = parseEuro(fee)
  const body = useCallback(
    (): CreateDunningRequest => ({
      noticeDate,
      days: Number(days) || initial.days,
      ...(feeCents !== null ? { feeCents } : {}),
      interest,
      interestFrom: interest && interestFrom ? interestFrom : null,
      business,
      flatFee: business && flatFee,
    }),
    [noticeDate, days, feeCents, interest, interestFrom, business, flatFee, initial.days],
  )

  // Live preview of the amounts (server computes; same rules as when issuing).
  useEffect(() => {
    const timer = setTimeout(() => {
      api<DunningAmounts>('POST', `/api/v1/documents/${doc.id}/dunning/preview`, body())
        .then((amounts) => {
          setPreview(amounts)
          if (!textEdited) setText(amounts.text)
          setError(null)
        })
        .catch((err) => setError(problem(err)))
    }, 300)
    return () => clearTimeout(timer)
  }, [body, doc.id, textEdited])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (feeCents === null) {
      setError(t('dun.feeInvalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api('POST', `/api/v1/documents/${doc.id}/dunning`, {
        ...body(),
        text: textEdited ? text : undefined,
        email: mail && to ? { to } : null,
      })
      onDone()
    } catch (err) {
      setError(problem(err))
    } finally {
      setBusy(false)
    }
  }

  const p = preview
  const rows: [string, string, boolean?][] = [
    [t('dun.open'), formatCents(p.openCents)],
    ...(p.earlierChargesCents
      ? ([[t('dun.earlier'), formatCents(p.earlierChargesCents)]] as [string, string][])
      : []),
    ...(p.feeCents ? ([[t('dun.feeRow'), formatCents(p.feeCents)]] as [string, string][]) : []),
    ...(p.flatFeeCents
      ? ([[t('dun.flatFee'), formatCents(p.flatFeeCents)]] as [string, string][])
      : []),
    ...(p.interestCents && p.interestFrom && p.interestTo
      ? ([
          [
            tf('dun.interestLine', {
              rate: percent(p.interestRatePercent),
              from: date(p.interestFrom),
              to: date(p.interestTo),
            }),
            formatCents(p.interestCents),
          ],
        ] as [string, string][])
      : []),
    [t('dun.total'), formatCents(p.totalCents), true],
  ]

  return (
    <form className="form dunning-form" onSubmit={submit} aria-label={levelLabel(initial.level)}>
      <h3>{levelLabel(initial.level)}</h3>
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-date`}>{t('dun.date')}</label>
          <input
            id={`${id}-date`}
            type="date"
            required
            value={noticeDate}
            onChange={(e) => setNoticeDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-days`}>{t('dun.days')}</label>
          <input
            id={`${id}-days`}
            type="number"
            min={1}
            max={90}
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        <MoneyField
          label={t('dun.fee')}
          name="fee"
          invalidText={t('doc.invalidAmount')}
          value={fee}
          onChange={setFee}
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={business} onChange={(e) => setBusiness(e.target.checked)} />
        <span>{t('dun.business')}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={interest} onChange={(e) => setInterest(e.target.checked)} />
        <span>{tf('dun.interest', { points: business ? '9' : '5' })}</span>
      </label>
      {interest ? (
        <div className="field">
          <label htmlFor={`${id}-from`}>{t('dun.interestFrom')}</label>
          <input
            id={`${id}-from`}
            type="date"
            value={interestFrom}
            onChange={(e) => setInterestFrom(e.target.value)}
            aria-describedby={`${id}-from-hint`}
          />
          <p id={`${id}-from-hint`} className="hint">
            {t('dun.interestFromHint')}
          </p>
        </div>
      ) : null}
      {business ? (
        <label className="check">
          <input type="checkbox" checked={flatFee} onChange={(e) => setFlatFee(e.target.checked)} />
          <span>{t('dun.flatFeeCheck')}</span>
        </label>
      ) : null}
      <div className="field">
        <label htmlFor={`${id}-text`}>{t('dun.text')}</label>
        <textarea
          id={`${id}-text`}
          rows={5}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setTextEdited(true)
          }}
        />
      </div>

      <dl className="receivable-sums" aria-live="polite">
        {rows.map(([label, value, strong]) => (
          <div key={label} className={strong ? 'is-strong' : undefined}>
            <dt>{label}</dt>
            <dd className="amount">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="hint">{tf('dun.deadline', { date: date(p.dueDate) })}</p>

      {emailEnabled ? (
        <>
          <label className="check">
            <input type="checkbox" checked={mail} onChange={(e) => setMail(e.target.checked)} />
            <span>{t('dun.mailCheck')}</span>
          </label>
          {mail ? (
            <div className="field">
              <label htmlFor={`${id}-to`}>{t('dun.mailTo')}</label>
              <input
                id={`${id}-to`}
                type="email"
                required
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          ) : null}
        </>
      ) : (
        <p className="hint">{t('dun.noMail')}</p>
      )}
      <p className="hint">{t('dun.final')}</p>
      <FormError>{error}</FormError>
      <div className="button-row">
        <Button type="submit" variant="primary" disabled={busy}>
          {tf('dun.issue', { level: levelLabel(initial.level) })}
        </Button>
        <Button type="button" variant="ghost" width="natural" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
