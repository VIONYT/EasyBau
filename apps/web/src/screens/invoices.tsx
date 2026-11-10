import type { InvoiceList, InvoiceListItem, ReceivableStatus } from '@opc/schemas'
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
}

function queryOf(filter: Filter, cursor?: string | null): string {
  const params = new URLSearchParams()
  if (filter.status) params.set('status', filter.status)
  if (filter.from) params.set('from', filter.from)
  if (filter.to) params.set('to', filter.to)
  if (filter.q.trim()) params.set('q', filter.q.trim())
  if (filter.retention) params.set('retention', 'true')
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

/** Rechnungsliste (DESIGN.md §2): status, open amount and sums over the filter. No bookkeeping. */
export function Invoices({ navigate }: { navigate: Navigate }) {
  const id = useId()
  const [filter, setFilter] = useState<Filter>({
    status: '',
    from: '',
    to: '',
    q: '',
    retention: false,
  })
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
  const set = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }))

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
            <button
              type="button"
              className="button ghost auto"
              onClick={() =>
                downloadFile(`/api/v1/invoices/export.csv?${queryOf(filter)}`).catch(
                  (err: ApiError) => setError(err.message),
                )
              }
            >
              {t('inv.list.csv')}
            </button>
          </div>
          {list.items.length ? (
            <ul className="list invoice-list">
              {list.items.map((item) => (
                <InvoiceRow key={item.id} item={item} navigate={navigate} />
              ))}
            </ul>
          ) : (
            <p className="muted">{t('inv.list.empty')}</p>
          )}
          {list.nextCursor ? (
            <button type="button" className="button ghost" onClick={more}>
              {t('inv.list.more')}
            </button>
          ) : null}
        </>
      ) : (
        <p className="muted">{t('common.loading')}</p>
      )}
    </section>
  )
}

function InvoiceRow({ item, navigate }: { item: InvoiceListItem; navigate: Navigate }) {
  const label = documentLabel({
    type: item.type,
    invoiceKind: item.invoiceKind,
    progressNo: item.progressNo,
    changeOrder: null,
  })
  return (
    <li className={`list-link${item.status === 'cancelled' ? ' is-cancelled' : ''}`}>
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
