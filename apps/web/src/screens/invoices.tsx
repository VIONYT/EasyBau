import type {
  DunningBatchResult,
  InvoiceList,
  InvoiceListItem,
  Me,
  ReceivableStatus,
} from '@easybau/schemas'
import { Button } from '@easybau/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api, downloadFile } from '../api'
import { formatCents, formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import type { Navigate } from '../router'
import { documentLabel } from './documents'
import { ReceivableChip } from './payments'

const STATUSES: (ReceivableStatus | 'draft')[] = [
  'open',
  'partially_paid',
  'overdue',
  'dunned',
  'paid',
  'cancelled',
  'draft',
]

interface Filter {
  status: string
  from: string
  to: string
  q: string
  retention: boolean
  dunningDue: boolean
}

function queryOf(filter: Filter, cursor?: string | null): string {
  const params = new URLSearchParams()
  if (filter.status) params.set('status', filter.status)
  if (filter.from) params.set('from', filter.from)
  if (filter.to) params.set('to', filter.to)
  if (filter.q.trim()) params.set('q', filter.q.trim())
  if (filter.retention) params.set('retention', 'true')
  if (filter.dunningDue) params.set('dunning', 'due')
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

/** Rechnungsliste (DESIGN.md §2): status, open amount and sums over the filter. No bookkeeping. */
export function Invoices({ me, navigate }: { me: Me; navigate: Navigate }) {
  const id = useId()
  const canDun = me.permissions.includes('dunning.write')
  const [filter, setFilter] = useState<Filter>({
    status: '',
    from: '',
    to: '',
    q: '',
    retention: false,
    dunningDue: false,
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mail, setMail] = useState(true)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<DunningBatchResult[] | null>(null)
  const [list, setList] = useState<InvoiceList | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((f: Filter) => {
    setError(null)
    api<InvoiceList>('GET', `/api/v1/invoices?${queryOf(f)}`)
      .then(setList)
      .catch((err: ApiError) => setError(err.message))
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => load(filter), 250)
    return () => clearTimeout(timer)
  }, [filter, load])

  const more = async () => {
    if (!list?.nextCursor) return
    try {
      const next = await api<InvoiceList>(
        'GET',
        `/api/v1/invoices?${queryOf(filter, list.nextCursor)}`,
      )
      setList({ ...next, items: [...list.items, ...next.items] })
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  const set = (patch: Partial<Filter>) => {
    setSelected(new Set())
    setFilter((f) => ({ ...f, ...patch }))
  }
  const toggle = (invoiceId: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(invoiceId)) next.delete(invoiceId)
      else next.add(invoiceId)
      return next
    })
  const due = list?.items.filter((i) => i.nextDunning?.due) ?? []
  const runBatch = async () => {
    if (!selected.size || !window.confirm(tf('dun.batch.confirm', { n: String(selected.size) }))) {
      return
    }
    setRunning(true)
    setError(null)
    try {
      const res = await api<{ results: DunningBatchResult[] }>('POST', '/api/v1/dunning/batch', {
        invoiceIds: [...selected],
        email: mail,
      })
      setResults(res.results)
      setSelected(new Set())
      load(filter)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>{t('nav.invoices')}</h1>
      <div className="panel filters">
        <div className="row">
          <div className="field">
            <label htmlFor={`${id}-status`}>{t('inv.list.status')}</label>
            <select
              id={`${id}-status`}
              className="select"
              value={filter.status}
              onChange={(e) => set({ status: e.target.value })}
            >
              <option value="">{t('inv.list.all')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`pay.status.${s}` as TextKey)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-q`}>{t('common.search')}</label>
            <input
              id={`${id}-q`}
              type="search"
              value={filter.q}
              onChange={(e) => set({ q: e.target.value })}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor={`${id}-from`}>{t('sys.from')}</label>
            <input
              id={`${id}-from`}
              type="date"
              value={filter.from}
              onChange={(e) => set({ from: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-to`}>{t('sys.to')}</label>
            <input
              id={`${id}-to`}
              type="date"
              value={filter.to}
              onChange={(e) => set({ to: e.target.value })}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={filter.retention}
            onChange={(e) => set({ retention: e.target.checked })}
          />
          <span>{t('inv.list.retention')}</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filter.dunningDue}
            onChange={(e) => set({ dunningDue: e.target.checked })}
          />
          <span>{t('dun.batch.filter')}</span>
        </label>
      </div>
      <FormError>{error}</FormError>
      {list ? (
        <>
          <dl className="panel invoice-sums" aria-label={t('inv.list.sums')}>
            <div>
              <dt>{tf('inv.list.count', { n: String(list.sums.count) })}</dt>
              <dd className="amount">{formatCents(list.sums.grossCents)}</dd>
            </div>
            <div>
              <dt>{t('pay.paid')}</dt>
              <dd className="amount">{formatCents(list.sums.paidCents)}</dd>
            </div>
            <div className="is-strong">
              <dt>{t('pay.open')}</dt>
              <dd className="amount">{formatCents(list.sums.openCents)}</dd>
            </div>
            <div className={list.sums.overdueCents ? 'is-warning' : undefined}>
              <dt>{t('inv.list.overdue')}</dt>
              <dd className="amount">{formatCents(list.sums.overdueCents)}</dd>
            </div>
          </dl>
          <div className="actions start">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                downloadFile(`/api/v1/invoices/export.csv?${queryOf(filter)}`).catch(
                  (err: ApiError) => setError(err.message),
                )
              }
            >
              {t('inv.list.csv')}
            </Button>
          </div>
          {results ? (
            <div className="panel" role="status">
              <h2>{t('dun.batch.results')}</h2>
              <ul className="list">
                {results.map((r) => (
                  <li key={r.invoiceId} className="list-row">
                    <span>
                      <strong>{r.number}</strong>
                      <span className={`block ${r.ok ? 'muted' : 'warning'}`}>
                        {r.ok
                          ? [
                              t(`dun.level.${r.level}` as TextKey),
                              r.emailedTo
                                ? tf('dun.batch.emailed', { to: r.emailedTo })
                                : t('dun.batch.pdfOnly'),
                            ].join(' · ')
                          : r.error}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {canDun && due.length ? (
            <div className="panel dunning-batch">
              <p>{tf('dun.batch.due', { n: String(due.length) })}</p>
              <div className="button-row">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setSelected(
                      selected.size === due.length ? new Set() : new Set(due.map((i) => i.id)),
                    )
                  }
                >
                  {t(selected.size === due.length ? 'dun.batch.none' : 'dun.batch.all')}
                </Button>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={mail}
                    onChange={(e) => setMail(e.target.checked)}
                  />
                  <span>{t('dun.batch.mail')}</span>
                </label>
                <Button
                  type="button"
                  variant="primary"
                  disabled={running || !selected.size}
                  onClick={runBatch}
                >
                  {tf('dun.batch.run', { n: String(selected.size) })}
                </Button>
              </div>
            </div>
          ) : null}
          {list.items.length ? (
            <ul className="list invoice-list">
              {list.items.map((item) => (
                <InvoiceRow
                  key={item.id}
                  item={item}
                  navigate={navigate}
                  selectable={canDun && Boolean(item.nextDunning?.due)}
                  selected={selected.has(item.id)}
                  onToggle={() => toggle(item.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="muted">{t('inv.list.empty')}</p>
          )}
          {list.nextCursor ? (
            <Button type="button" variant="ghost" width="natural" onClick={more}>
              {t('inv.list.more')}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="muted">{t('common.loading')}</p>
      )}
    </section>
  )
}

function InvoiceRow({
  item,
  navigate,
  selectable,
  selected,
  onToggle,
}: {
  item: InvoiceListItem
  navigate: Navigate
  selectable: boolean
  selected: boolean
  onToggle: () => void
}) {
  const label = documentLabel({
    type: item.type,
    invoiceKind: item.invoiceKind,
    progressNo: item.progressNo,
    changeOrder: null,
  })
  return (
    <li
      className={`list-link${item.status === 'cancelled' ? ' is-cancelled' : ''}${selectable ? ' selectable' : ''}`}
    >
      {selectable ? (
        <label className="row-select">
          <input
            type="checkbox"
            className="row-select-box"
            checked={selected}
            onChange={onToggle}
          />
          <span className="sr-only">{tf('dun.batch.select', { number: item.number ?? '' })}</span>
        </label>
      ) : null}
      <a
        href={`/dokumente/${item.id}`}
        onClick={(e) => {
          e.preventDefault()
          navigate({ view: 'document', id: item.id })
        }}
      >
        <span className="invoice-head">
          <strong>{item.number ?? t('pay.status.draft')}</strong>
          <ReceivableChip status={item.status} />
        </span>
        <span>
          {label}
          {item.recipient ? ` · ${item.recipient}` : ''}
        </span>
        <span className="muted">
          {[item.project.number, item.project.name].filter(Boolean).join(' ')} ·{' '}
          {formatDateTime(item.documentDate, 'date')}
          {item.dueDate
            ? ` · ${tf('inv.list.due', { date: formatDateTime(item.dueDate, 'date') })}`
            : ''}
          {item.overdueDays ? ` (${tf('pay.overdueDays', { n: String(item.overdueDays) })})` : ''}
        </span>
        {item.dunningLevel || item.nextDunning ? (
          <span className={item.nextDunning?.due ? 'warning' : 'muted'}>
            {[
              item.dunningLevel
                ? tf('dun.batch.last', { level: t(`dun.level.${item.dunningLevel}` as TextKey) })
                : null,
              item.nextDunning
                ? tf(item.nextDunning.due ? 'dun.batch.nextDue' : 'dun.batch.nextFrom', {
                    level: t(`dun.level.${item.nextDunning.level}` as TextKey),
                    date: formatDateTime(item.nextDunning.possibleFrom, 'date'),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
        <span className="invoice-amounts">
          <span className="amount">{formatCents(item.grossCents)}</span>
          {item.status !== 'draft' && item.status !== 'cancelled' ? (
            <span className="amount">
              {t('pay.open')}: {formatCents(item.openCents)}
            </span>
          ) : null}
        </span>
      </a>
    </li>
  )
}
