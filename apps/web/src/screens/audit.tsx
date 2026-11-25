import type { AuditChainStatus, AuditEventItem, AuditEventList, Me } from '@easybau/schemas'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import { auditText, ExportPanel } from './system'

/** Areas of the Änderungsprotokoll that can be filtered (entity names of the database). */
const ENTITIES = [
  'document',
  'document_item',
  'document_artifact',
  'payment',
  'receivable_adjustment',
  'dunning_notice',
  'incoming_invoice',
  'incoming_invoice_allocation',
  'business_area',
  'contact',
  'project',
  'tenant',
  'tax_rate',
  'payment_term',
  'membership',
  'role',
  'invitation',
  'measurement_sheet',
  'measurement_line',
  'report',
  'file',
  'catalog_item',
  'letterhead',
] as const

/** Text or undefined for keys that may not exist (e.g. new entities). */
const maybe = (key: string): string | undefined => t(key as TextKey) as string | undefined

const entityLabel = (entity: string) => maybe(`audit.entity.${entity}`) ?? entity

function actionLabel(action: string): string {
  const [kind, detail] = action.split(':', 2)
  const base = maybe(`audit.action.${kind}`) ?? (kind as string)
  return detail ? `${base}: ${detail}` : base
}

const show = (value: unknown) =>
  value === null || value === undefined
    ? '–'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)

/**
 * Prüfung (GoBD Z1/Z3): Änderungsprotokoll with its hash-chain check and the exports for the
 * tax advisor and the Betriebsprüfung. Read-only; also for the time-limited Prüfer access.
 */
export function AuditScreen({ me }: { me: Me }) {
  return (
    <section aria-labelledby="audit-title">
      <h1 id="audit-title">{t('nav.audit')}</h1>
      {me.role.key === 'auditor' ? <p className="hint">{t('audit.auditorHint')}</p> : null}
      <ChainPanel />
      <EventsPanel />
      {me.permissions.includes('export.run') ? <ExportPanel /> : null}
    </section>
  )
}

function ChainPanel() {
  const [status, setStatus] = useState<AuditChainStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<AuditChainStatus>('GET', '/api/v1/audit/chain')
      .then(setStatus)
      .catch((err: ApiError) => setError(err.message))
  }, [])
  const check = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await api<AuditChainStatus>('POST', '/api/v1/audit/chain/check', {}))
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  const last = status?.last
  return (
    <div className="panel">
      <h2>{t('sys.auditChain')}</h2>
      <p className="hint">{t('audit.chainHint')}</p>
      {status ? (
        <p
          className={last?.problem ? 'form-error' : status.stale ? 'warning-text' : 'success'}
          role="status"
        >
          {auditText({
            lastCheckAt: last?.checkedAt ?? null,
            problem: last?.problem ?? null,
            brokenSeq: last?.brokenSeq ?? null,
            events: last?.events ?? 0,
          })}
          {last ? ` ${t(`audit.origin.${last.origin}` as TextKey)}` : ''}
          {last?.checkedBy ? ` (${last.checkedBy})` : ''}
        </p>
      ) : null}
      <FormError>{error}</FormError>
      <button type="button" className="button ghost auto" disabled={busy} onClick={check}>
        {busy ? t('audit.checking') : t('audit.checkNow')}
      </button>
    </div>
  )
}

interface Filter {
  entity: string
  from: string
  to: string
}

function queryOf(filter: Filter, cursor?: string | null) {
  const params = new URLSearchParams({ limit: '50' })
  if (filter.entity) params.set('entity', filter.entity)
  if (filter.from) params.set('from', filter.from)
  if (filter.to) params.set('to', filter.to)
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

function EventsPanel() {
  const id = useId()
  const [filter, setFilter] = useState<Filter>({ entity: '', from: '', to: '' })
  const [list, setList] = useState<AuditEventList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback((f: Filter) => {
    setError(null)
    api<AuditEventList>('GET', `/api/v1/audit/events?${queryOf(f)}`)
      .then(setList)
      .catch((err: ApiError) => setError(err.message))
  }, [])
  useEffect(() => load(filter), [filter, load])
  const more = async () => {
    if (!list?.nextCursor) return
    try {
      const next = await api<AuditEventList>(
        'GET',
        `/api/v1/audit/events?${queryOf(filter, list.nextCursor)}`,
      )
      setList({ ...next, items: [...list.items, ...next.items] })
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  const set = (patch: Partial<Filter>) => setFilter((f) => ({ ...f, ...patch }))
  return (
    <div className="panel">
      <h2>{t('audit.events')}</h2>
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-entity`}>{t('audit.entity')}</label>
          <select
            id={`${id}-entity`}
            className="select"
            value={filter.entity}
            onChange={(e) => set({ entity: e.target.value })}
          >
            <option value="">{t('inv.list.all')}</option>
            {ENTITIES.map((e) => (
              <option key={e} value={e}>
                {entityLabel(e)}
              </option>
            ))}
          </select>
        </div>
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
      <FormError>{error}</FormError>
      {list ? (
        list.items.length ? (
          <ul className="list audit-events">
            {list.items.map((e) => (
              <EventRow key={e.seq} event={e} />
            ))}
          </ul>
        ) : (
          <p className="muted">{t('audit.empty')}</p>
        )
      ) : (
        <p className="muted">{t('common.loading')}</p>
      )}
      {list?.nextCursor ? (
        <button type="button" className="button ghost" onClick={more}>
          {t('inv.list.more')}
        </button>
      ) : null}
    </div>
  )
}

function EventRow({ event: e }: { event: AuditEventItem }) {
  return (
    <li>
      <details>
        <summary className="audit-summary">
          <span className="audit-head">
            <strong>
              {actionLabel(e.action)} · {entityLabel(e.entity)}
            </strong>
            <span className="muted">
              {tf('audit.line', {
                seq: String(e.seq),
                when: formatDateTime(e.createdAt),
                who: e.actor ?? t('audit.system'),
              })}
            </span>
          </span>
        </summary>
        {e.changes.length ? (
          <div className="table-scroll">
            <table className="audit-changes">
              <thead>
                <tr>
                  <th scope="col" className="audit-cell">
                    {t('audit.field')}
                  </th>
                  <th scope="col" className="audit-cell">
                    {t('audit.before')}
                  </th>
                  <th scope="col" className="audit-cell">
                    {t('audit.after')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {e.changes.map((c) => (
                  <tr key={c.field}>
                    <th scope="row" className="audit-cell">
                      {c.field}
                    </th>
                    <td className="audit-cell">{show(c.before)}</td>
                    <td className="audit-cell">{show(c.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : e.redactedAt ? (
          <p className="muted">
            {tf('audit.redacted', { when: formatDateTime(e.redactedAt, 'date') })}
          </p>
        ) : (
          <p className="muted">{t('audit.noChanges')}</p>
        )}
        {e.entityId ? <p className="muted">{tf('audit.record', { id: e.entityId })}</p> : null}
      </details>
    </li>
  )
}
