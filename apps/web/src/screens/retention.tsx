import type {
  PurgeDocumentsResult,
  PurgeLogEntry,
  RetentionDueDocument,
  RetentionOverview,
} from '@easybau/schemas'
import { Button, DataTable } from '@easybau/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tn } from '../i18n'

const germanDate = (iso: string) => iso.split('-').reverse().join('.')

const typeLabel = (type: string) =>
  type === 'invoice' ? t('doc.invoice.standard') : t(`doc.type.${type}` as TextKey)

/**
 * Aufbewahrung (C.12): documents whose retention period has ended can be anonymised after an
 * admin's approval; the Löschprotokoll stays as proof. Read-only for everyone else (Prüfer).
 */
export function RetentionPanel({ canManage }: { canManage: boolean }) {
  const [overview, setOverview] = useState<RetentionOverview | null>(null)
  const [log, setLog] = useState<PurgeLogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    Promise.all([
      api<RetentionOverview>('GET', '/api/v1/retention'),
      api<PurgeLogEntry[]>('GET', '/api/v1/retention/log'),
    ])
      .then(([o, l]) => {
        setOverview(o)
        setLog(l)
      })
      .catch((err: ApiError) => setError(err.message))
  }, [])
  useEffect(load, [load])
  return (
    <div className="panel">
      <h2>{t('ret.title')}</h2>
      <p className="hint">{t('ret.hint')}</p>
      <FormError>{error}</FormError>
      {overview ? (
        <>
          <RetentionYears years={overview.retentionYears} canManage={canManage} onSaved={load} />
          <DueDocuments overview={overview} canManage={canManage} onDone={load} />
        </>
      ) : null}
      <h3>{t('ret.log')}</h3>
      <DataTable
        caption={t('ret.log')}
        rows={log}
        rowKey={(e) => e.documentId}
        empty={<p className="muted">{t('ret.logEmpty')}</p>}
        columns={[
          {
            key: 'doc',
            header: t('ret.document'),
            rowHeader: true,
            cell: (e) => `${typeLabel(e.type)} ${e.number}`,
          },
          { key: 'date', header: t('ret.date'), cell: (e) => germanDate(e.documentDate) },
          { key: 'end', header: t('ret.end'), cell: (e) => germanDate(e.retentionEnd) },
          {
            key: 'by',
            header: t('ret.approved'),
            cell: (e) => `${formatDateTime(e.purgedAt ?? e.approvedAt)} · ${e.approvedBy ?? '–'}`,
          },
          {
            key: 'originals',
            header: t('ret.originals'),
            cell: (e) =>
              e.archivePending
                ? tn('ret.archivePending', e.archivePending)
                : e.filesPending
                  ? tn('ret.filesPending', e.filesPending)
                  : tn('ret.originalsDeleted', e.originals),
          },
        ]}
      />
    </div>
  )
}

function RetentionYears({
  years,
  canManage,
  onSaved,
}: {
  years: number
  canManage: boolean
  onSaved: () => void
}) {
  const id = useId()
  const [value, setValue] = useState(String(years))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => setValue(String(years)), [years])
  if (!canManage) return <p>{tn('ret.yearsInfo', years)}</p>
  const save = async () => {
    setError(null)
    setSaved(false)
    try {
      await api('PUT', '/api/v1/settings/retention', { retentionYears: Number(value) })
      setSaved(true)
      onSaved()
    } catch (err) {
      const e = err as ApiError
      setError(e.fieldErrors.retentionYears ?? e.message)
    }
  }
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor={id}>{t('ret.years')}</label>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={8}
          max={30}
          value={value}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setValue(e.target.value)}
        />
        <p id={`${id}-hint`} className="hint">
          {t('ret.yearsHint')}
        </p>
      </div>
      <FormError>{error}</FormError>
      {saved ? (
        <p className="success" role="status">
          {t('doc.saved')}
        </p>
      ) : null}
      <Button type="button" variant="ghost" width="natural" onClick={() => void save()}>
        {t('common.save')}
      </Button>
    </div>
  )
}

function DueDocuments({
  overview,
  canManage,
  onDone,
}: {
  overview: RetentionOverview
  canManage: boolean
  onDone: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PurgeDocumentsResult | null>(null)
  const due = overview.due
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const purge = async () => {
    const ids = [...selected].slice(0, 100)
    if (!window.confirm(tn('ret.confirm', ids.length))) return
    setBusy(true)
    setError(null)
    try {
      setResult(
        await api<PurgeDocumentsResult>('POST', '/api/v1/retention/purge', {
          documentIds: ids,
          confirm: true,
        }),
      )
      setSelected(new Set())
      onDone()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  const select = canManage
    ? [
        {
          key: 'select',
          header: t('ret.select'),
          cell: (d: RetentionDueDocument) => (
            <input
              type="checkbox"
              aria-label={`${typeLabel(d.type)} ${d.number}`}
              checked={selected.has(d.id)}
              onChange={() => toggle(d.id)}
            />
          ),
        },
      ]
    : []
  return (
    <>
      <h3>{tn('ret.due', due.length)}</h3>
      {result ? (
        <p className={result.failed.length ? 'warning-text' : 'success'} role="status">
          {tn('ret.result', result.purged)}
          {result.failed.map((f) => ` ${f.message}`).join('')}
        </p>
      ) : null}
      <DataTable
        caption={t('ret.dueCaption')}
        rows={due}
        rowKey={(d) => d.id}
        maxHeight="60vh"
        empty={<p className="muted">{t('ret.none')}</p>}
        columns={[
          ...select,
          {
            key: 'doc',
            header: t('ret.document'),
            rowHeader: true,
            cell: (d) => `${typeLabel(d.type)} ${d.number}`,
          },
          { key: 'date', header: t('ret.date'), cell: (d) => germanDate(d.documentDate) },
          { key: 'end', header: t('ret.end'), cell: (d) => germanDate(d.retentionEnd) },
          {
            key: 'recipient',
            header: t('ret.recipient'),
            cell: (d) => [d.recipient, d.projectNumber].filter(Boolean).join(' · '),
          },
          { key: 'originals', header: t('ret.originals'), numeric: true, cell: (d) => d.originals },
        ]}
      />
      {overview.more ? <p className="hint">{t('ret.more')}</p> : null}
      {canManage && due.length ? (
        <div className="button-row">
          <Button
            type="button"
            variant="ghost"
            width="natural"
            onClick={() => setSelected(new Set(due.slice(0, 100).map((d) => d.id)))}
          >
            {t('ret.selectAll')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            width="natural"
            disabled={busy || selected.size === 0}
            onClick={() => void purge()}
          >
            {busy ? t('ret.busy') : tn('ret.purge', selected.size)}
          </Button>
        </div>
      ) : null}
      <FormError>{error}</FormError>
    </>
  )
}
