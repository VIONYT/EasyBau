import type {
  BusinessArea,
  CostType,
  IncomingEinvoiceView,
  IncomingInvoiceDetail,
  IncomingInvoiceList,
  IncomingInvoiceListItem,
  Me,
  Page,
  ProjectSummary,
} from '@opc/schemas'
import { COST_TYPES, INCOMING_UPLOAD_EXTENSIONS } from '@opc/schemas/constants'
import { type DragEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { type ApiError, api, apiWithEtag, uploadFile } from '../api'
import { centsToInput, formatBytes, formatCents, formatDateTime, parseEuro } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import type { Navigate } from '../router'

/**
 * Eingangsrechnungen (P1.11): receive PDF/ZUGFeRD/XRechnung/photos, review ("Zu prüfen") with
 * cost allocation to projects or business areas, "Prüfung bestätigen", payment status. The
 * received original stays unchanged and is archived; there is no bookkeeping here.
 */

type ListFilter = 'review' | 'open' | 'overdue' | 'paid' | 'all'

const FILTERS: { key: ListFilter; label: TextKey }[] = [
  { key: 'review', label: 'in.filter.review' },
  { key: 'open', label: 'in.filter.open' },
  { key: 'overdue', label: 'in.filter.overdue' },
  { key: 'paid', label: 'in.filter.paid' },
  { key: 'all', label: 'in.filter.all' },
]

/** Zeitraum (Rechnungsdatum) and Zuweisung (p:<project> or b:<business area>). */
interface ExtraFilter {
  from: string
  to: string
  target: string
}
const NO_EXTRA: ExtraFilter = { from: '', to: '', target: '' }

function queryOf(
  filter: ListFilter,
  q: string,
  cursor?: string | null,
  extra: ExtraFilter = NO_EXTRA,
): string {
  const params = new URLSearchParams()
  if (filter === 'review') params.set('status', 'review')
  if (filter === 'open' || filter === 'overdue' || filter === 'paid') params.set('payment', filter)
  if (q.trim()) params.set('q', q.trim())
  if (extra.from) params.set('from', extra.from)
  if (extra.to) params.set('to', extra.to)
  if (extra.target.startsWith('p:')) params.set('projectId', extra.target.slice(2))
  if (extra.target.startsWith('b:')) params.set('businessAreaId', extra.target.slice(2))
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

const ACCEPT = INCOMING_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(',')

export function IncomingStatusChip({ item }: { item: IncomingInvoiceListItem }) {
  if (item.status === 'confirmed') {
    if (item.paidOn) return <span className="chip chip--pay-paid">{t('in.status.paid')}</span>
    if (item.overdue)
      return <span className="chip chip--pay-overdue">{t('in.status.overdue')}</span>
    return <span className="chip chip--pay-open">{t('in.status.open')}</span>
  }
  return (
    <span className={`chip chip--in-${item.status}`}>
      {t(`in.status.${item.status}` as TextKey)}
    </span>
  )
}

/** List with "Zu prüfen" first, upload by button or drag and drop. */
export function IncomingInvoices({ me, navigate }: { me: Me; navigate: Navigate }) {
  const id = useId()
  const canWrite = me.permissions.includes('incoming_invoice.write')
  const [filter, setFilter] = useState<ListFilter>(canWrite ? 'review' : 'all')
  const [q, setQ] = useState('')
  const [extra, setExtra] = useState<ExtraFilter>(NO_EXTRA)
  const [targets, setTargets] = useState<{ projects: ProjectSummary[]; areas: BusinessArea[] }>({
    projects: [],
    areas: [],
  })
  useEffect(() => {
    Promise.all([
      api<Page<ProjectSummary>>('GET', '/api/v1/projects?limit=100'),
      api<BusinessArea[]>('GET', '/api/v1/business-areas'),
    ])
      .then(([projects, areas]) => setTargets({ projects: projects.items, areas }))
      .catch(() => undefined)
  }, [])
  const [list, setList] = useState<IncomingInvoiceList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<
    { name: string; status: 'busy' | 'done' | 'failed'; message?: string; id?: string }[]
  >([])
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback((f: ListFilter, query: string, more: ExtraFilter) => {
    setError(null)
    api<IncomingInvoiceList>('GET', `/api/v1/incoming-invoices?${queryOf(f, query, null, more)}`)
      .then(setList)
      .catch((err: ApiError) => setError(err.message))
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => load(filter, q, extra), 250)
    return () => clearTimeout(timer)
  }, [filter, q, extra, load])

  const more = async () => {
    if (!list?.nextCursor) return
    try {
      const next = await api<IncomingInvoiceList>(
        'GET',
        `/api/v1/incoming-invoices?${queryOf(filter, q, list.nextCursor, extra)}`,
      )
      setList({ ...next, items: [...list.items, ...next.items] })
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    const queue = [...files]
    setUploads(queue.map((f) => ({ name: f.name, status: 'busy' })))
    let lastId: string | undefined
    for (const [index, file] of queue.entries()) {
      try {
        const created = await uploadFile<IncomingInvoiceDetail>(
          `/api/v1/incoming-invoices?filename=${encodeURIComponent(file.name)}`,
          file,
        )
        lastId = created.id
        setUploads((u) =>
          u.map((s, i) => (i === index ? { ...s, status: 'done', id: created.id } : s)),
        )
      } catch (err) {
        const e = err as ApiError
        const existing = e.fieldErrors?.existingId
        setUploads((u) =>
          u.map((s, i) =>
            i === index
              ? {
                  ...s,
                  status: 'failed',
                  message: e.message,
                  ...(existing ? { id: existing } : {}),
                }
              : s,
          ),
        )
      }
    }
    if (queue.length === 1 && lastId) {
      navigate({ view: 'incomingInvoice', id: lastId })
      return
    }
    load(filter, q, extra)
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    if (canWrite) upload(event.dataTransfer.files)
  }

  return (
    // Drag and drop is an extra for desktops; the upload button works with keyboard and touch.
    <section
      aria-labelledby={`${id}-title`}
      className={`incoming${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (!canWrite) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <h1 id={`${id}-title`}>{t('nav.incoming')}</h1>
      {canWrite ? (
        <div className="panel">
          <p className="hint">{t('in.uploadHint')}</p>
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              upload(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className="button primary auto"
            onClick={() => input.current?.click()}
          >
            {t('in.upload')}
          </button>
          {uploads.length ? (
            <ul className="list upload-status" aria-live="polite">
              {uploads.map((u) => (
                <li key={u.name} className="list-row">
                  <span>
                    <strong>{u.name}</strong>
                    <span className="muted block">
                      {u.status === 'busy'
                        ? t('in.uploading')
                        : u.status === 'done'
                          ? t('in.uploaded')
                          : u.message}
                    </span>
                  </span>
                  {u.id ? (
                    <button
                      type="button"
                      className="button ghost small"
                      onClick={() => navigate({ view: 'incomingInvoice', id: u.id as string })}
                    >
                      {t('in.open')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <nav className="chips" aria-label={t('in.filter')}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-current={filter === f.key ? 'true' : undefined}
            onClick={() => setFilter(f.key)}
          >
            {t(f.label)}
            {f.key === 'review' && list?.reviewCount ? (
              <span className="count">{list.reviewCount}</span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="field">
        <label htmlFor={`${id}-q`}>{t('common.search')}</label>
        <input id={`${id}-q`} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="row filters">
        <div className="field">
          <label htmlFor={`${id}-from`}>{t('in.filter.from')}</label>
          <input
            id={`${id}-from`}
            type="date"
            value={extra.from}
            onChange={(e) => setExtra({ ...extra, from: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-to`}>{t('in.filter.to')}</label>
          <input
            id={`${id}-to`}
            type="date"
            value={extra.to}
            onChange={(e) => setExtra({ ...extra, to: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-target`}>{t('in.filter.target')}</label>
          <select
            id={`${id}-target`}
            className="select"
            value={extra.target}
            onChange={(e) => setExtra({ ...extra, target: e.target.value })}
          >
            <option value="">{t('in.filter.anyTarget')}</option>
            {targets.projects.length ? (
              <optgroup label={t('in.projects')}>
                {targets.projects.map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>
                    {p.number ? `${p.number} · ` : ''}
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {targets.areas.length ? (
              <optgroup label={t('in.businessAreas')}>
                {targets.areas.map((a) => (
                  <option key={a.id} value={`b:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>
      </div>
      <FormError>{error}</FormError>
      {list ? (
        list.items.length ? (
          <ul className="list invoice-list">
            {list.items.map((item) => (
              <IncomingRow key={item.id} item={item} navigate={navigate} />
            ))}
          </ul>
        ) : (
          <p className="muted">{t(filter === 'review' ? 'in.emptyReview' : 'in.empty')}</p>
        )
      ) : (
        <p className="muted">{t('common.loading')}</p>
      )}
      {list?.nextCursor ? (
        <button type="button" className="button ghost" onClick={more}>
          {t('inv.list.more')}
        </button>
      ) : null}
    </section>
  )
}

function IncomingRow({ item, navigate }: { item: IncomingInvoiceListItem; navigate: Navigate }) {
  const closed = item.status === 'cancelled' || item.status === 'discarded'
  return (
    <li className={`list-link${closed ? ' is-cancelled' : ''}`}>
      <a
        href={`/eingangsrechnungen/${item.id}`}
        onClick={(e) => {
          e.preventDefault()
          navigate({ view: 'incomingInvoice', id: item.id })
        }}
      >
        <span className="invoice-head">
          <strong>{item.supplierName ?? t('in.unknownSupplier')}</strong>
          <IncomingStatusChip item={item} />
        </span>
        <span>
          {[
            item.documentKind === 'credit_note' ? t('in.creditNote') : null,
            item.invoiceNumber,
            item.invoiceDate ? formatDateTime(item.invoiceDate, 'date') : null,
            t(`in.source.${item.source}` as TextKey),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {item.allocatedTo.length ? (
          <span className="muted">{item.allocatedTo.join(', ')}</span>
        ) : null}
        <span className="invoice-amounts">
          <span className="amount">{formatCents(item.grossCents)}</span>
          {item.dueDate && item.status === 'confirmed' && !item.paidOn ? (
            <span className="muted">
              {tf('inv.list.due', { date: formatDateTime(item.dueDate, 'date') })}
            </span>
          ) : null}
        </span>
      </a>
    </li>
  )
}

// ---- Detail ----------------------------------------------------------------------------------

interface TaxRow {
  rate: string
  net: string
  tax: string
}
interface AllocationRow {
  key: number
  target: string
  costType: CostType
  rate: string
  net: string
  description: string
  /** Kostenzuweisung je Rechnungsposition (e-invoice line). */
  lineId: string | null
}
interface Form {
  documentKind: 'invoice' | 'credit_note'
  supplierName: string
  supplierVatId: string
  supplierTaxNumber: string
  supplierAddress: string
  supplierIban: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  net: string
  tax: string
  gross: string
  reverseCharge: boolean
  note: string
  taxLines: TaxRow[]
  allocations: AllocationRow[]
}

let rowKey = 0

function formOf(d: IncomingInvoiceDetail): Form {
  return {
    documentKind: d.documentKind,
    supplierName: d.supplierName ?? '',
    supplierVatId: d.supplierVatId ?? '',
    supplierTaxNumber: d.supplierTaxNumber ?? '',
    supplierAddress: d.supplierAddress ?? '',
    supplierIban: d.supplierIban ?? '',
    invoiceNumber: d.invoiceNumber ?? '',
    invoiceDate: d.invoiceDate ?? '',
    dueDate: d.dueDate ?? '',
    net: centsToInput(d.netCents),
    tax: centsToInput(d.taxCents),
    gross: centsToInput(d.grossCents),
    reverseCharge: d.reverseCharge,
    note: d.note ?? '',
    taxLines: d.taxLines.map((l) => ({
      rate: l.ratePercent.replace('.', ','),
      net: centsToInput(l.netCents),
      tax: centsToInput(l.taxCents),
    })),
    allocations: d.allocations.map((a) => ({
      key: ++rowKey,
      target: a.projectId ? `p:${a.projectId}` : `b:${a.businessAreaId}`,
      costType: a.costType,
      rate: a.ratePercent.replace('.', ','),
      net: centsToInput(a.netCents),
      description: a.description ?? '',
      lineId: a.lineId,
    })),
  }
}

const cents = (text: string): number => {
  const value = parseEuro(text)
  return value === null || Number.isNaN(value) ? 0 : value
}
const rateOf = (text: string) =>
  text
    .trim()
    .replace(',', '.')
    .replace(/\.0+$|(\.\d*?)0+$/, '$1')

function requestOf(form: Form) {
  return {
    documentKind: form.documentKind,
    supplierName: form.supplierName,
    supplierVatId: form.supplierVatId,
    supplierTaxNumber: form.supplierTaxNumber,
    supplierAddress: form.supplierAddress,
    supplierIban: form.supplierIban.replace(/\s/g, ''),
    invoiceNumber: form.invoiceNumber,
    invoiceDate: form.invoiceDate || null,
    dueDate: form.dueDate || null,
    netCents: cents(form.net),
    taxCents: cents(form.tax),
    grossCents: cents(form.gross),
    reverseCharge: form.reverseCharge,
    note: form.note,
    taxLines: form.taxLines
      .filter((l) => l.rate.trim())
      .map((l) => ({ ratePercent: l.rate.trim(), netCents: cents(l.net), taxCents: cents(l.tax) })),
    allocations: form.allocations
      .filter((a) => a.target)
      .map((a) => ({
        projectId: a.target.startsWith('p:') ? a.target.slice(2) : null,
        businessAreaId: a.target.startsWith('b:') ? a.target.slice(2) : null,
        costType: a.costType,
        ratePercent: a.rate.trim() || '0',
        netCents: cents(a.net),
        description: a.description,
        lineId: a.lineId,
      })),
  }
}

export function IncomingInvoiceScreen({ id, navigate }: { id: string; navigate: Navigate }) {
  const headingId = useId()
  const [detail, setDetail] = useState<IncomingInvoiceDetail | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [areas, setAreas] = useState<BusinessArea[]>([])

  const show = useCallback((result: { data: IncomingInvoiceDetail; etag: string | null }) => {
    setDetail(result.data)
    setEtag(result.etag)
    setForm(formOf(result.data))
    setDirty(false)
  }, [])

  useEffect(() => {
    apiWithEtag<IncomingInvoiceDetail>('GET', `/api/v1/incoming-invoices/${id}`)
      .then(show)
      .catch((err: ApiError) => setError(err.message))
  }, [id, show])

  const editable = Boolean(detail?.canEdit && detail.status === 'review')
  useEffect(() => {
    if (!editable) return
    api<Page<ProjectSummary>>('GET', '/api/v1/projects?limit=100')
      .then((page) => setProjects(page.items))
      .catch(() => undefined)
    api<BusinessArea[]>('GET', '/api/v1/business-areas')
      .then((list) => setAreas(list.filter((a) => !a.archived)))
      .catch(() => undefined)
  }, [editable])

  const run = async (call: () => Promise<{ data: IncomingInvoiceDetail; etag: string | null }>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      show(await call())
    } catch (err) {
      const e = err as ApiError
      setError(e.message)
      setFieldErrors(e.fieldErrors ?? {})
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    apiWithEtag<IncomingInvoiceDetail>(
      'PATCH',
      `/api/v1/incoming-invoices/${id}`,
      requestOf(form as Form),
      etag,
    )
  const action =
    (path: string, body: unknown = {}) =>
    () =>
      apiWithEtag<IncomingInvoiceDetail>('POST', `/api/v1/incoming-invoices/${id}/${path}`, body)

  if (!detail || !form) {
    return error ? <FormError>{error}</FormError> : <p className="muted">{t('common.loading')}</p>
  }
  const update = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch })
    setDirty(true)
  }
  const original = `/api/v1/incoming-invoices/${id}/original`

  return (
    <article aria-labelledby={headingId} className="incoming-detail">
      <p>
        <a
          href="/eingangsrechnungen"
          onClick={(e) => {
            e.preventDefault()
            navigate({ view: 'incoming' })
          }}
        >
          ← {t('nav.incoming')}
        </a>
      </p>
      <div className="invoice-head">
        <h1 id={headingId}>
          {detail.supplierName ?? t('in.unknownSupplier')}
          {detail.invoiceNumber ? ` · ${detail.invoiceNumber}` : ''}
        </h1>
        <IncomingStatusChip item={detail} />
      </div>
      <p className="muted">
        {tf('in.received', {
          date: formatDateTime(detail.receivedAt),
          name: detail.uploadedBy ?? '–',
        })}
        {detail.confirmedAt
          ? ` · ${tf('in.confirmedBy', {
              date: formatDateTime(detail.confirmedAt),
              name: detail.confirmedBy ?? '–',
            })}`
          : ''}
      </p>
      {detail.closedAt ? (
        <p className="warning">
          {t(detail.status === 'discarded' ? 'in.discardedNote' : 'in.cancelledNote')}{' '}
          {detail.closeReason}
        </p>
      ) : null}

      <div className="incoming-grid">
        <section className="panel incoming-original" aria-label={t('in.original')}>
          <h2>{t('in.original')}</h2>
          {detail.mimeType.startsWith('image/') ? (
            <a href={original} target="_blank" rel="noopener">
              <img src={original} alt={tf('in.originalOf', { name: detail.filename })} />
            </a>
          ) : null}
          {detail.mimeType === 'application/pdf' ? (
            <iframe
              className="incoming-pdf"
              src={original}
              title={tf('in.originalOf', { name: detail.filename })}
            />
          ) : null}
          {detail.receivedVia === 'email' ? (
            <p className="hint">
              {tf('in.viaEmail', {
                from: detail.emailFrom ?? '–',
                subject: detail.emailSubject ?? '–',
              })}
            </p>
          ) : null}
          <p>
            <strong>{detail.filename}</strong>
            <span className="muted block">
              {t(`in.source.${detail.source}` as TextKey)} · {formatBytes(detail.sizeBytes)}
            </span>
          </p>
          <div className="button-row">
            {detail.inline ? (
              <a className="button ghost auto" href={original} target="_blank" rel="noopener">
                {t('in.openOriginal')}
              </a>
            ) : null}
            <a className="button ghost auto" href={`${original}?download=true`}>
              {t('in.download')}
            </a>
          </div>
          <p className="muted">
            {detail.archive.archived
              ? tf('in.archived', { date: formatDateTime(detail.archive.retainUntil, 'date') })
              : t('in.archivePending')}
          </p>
          {detail.einvoice ? <EinvoiceView detail={detail} einvoice={detail.einvoice} /> : null}
        </section>

        <section className="panel" aria-labelledby={`${headingId}-data`}>
          <h2 id={`${headingId}-data`}>{t('in.data')}</h2>
          {detail.problems.length && editable ? (
            <div className="hints" role="status">
              <strong>{t('in.problems')}</strong>
              <ul>
                {detail.problems.map((p) => (
                  <li key={`${p.field}-${p.message}`}>{p.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {detail.warnings.length ? (
            <ul className="warning-list">
              {detail.warnings.map((w) => (
                <li key={w.message} className="warning">
                  {w.message}
                </li>
              ))}
            </ul>
          ) : null}
          {editable ? (
            <ReviewForm
              form={form}
              update={update}
              projects={projects}
              areas={areas}
              errors={fieldErrors}
              lines={detail.einvoice?.lines ?? []}
            />
          ) : (
            <ReadOnlyData detail={detail} />
          )}
          <FormError>{error}</FormError>
          {editable ? (
            <div className="button-row">
              <button
                type="button"
                className="button ghost auto"
                disabled={busy}
                onClick={() => run(save)}
              >
                {t('common.save')}
              </button>
              <button
                type="button"
                className="button primary auto"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (dirty) {
                      const saved = await save()
                      show(saved)
                    }
                    return action('confirm')()
                  })
                }
              >
                {t('in.confirm')}
              </button>
              <button
                type="button"
                className="button ghost auto danger"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(t('in.discardReason'))
                  if (reason?.trim()) run(action('discard', { reason }))
                }}
              >
                {t('in.discard')}
              </button>
            </div>
          ) : null}
          {detail.status === 'confirmed' && detail.canEdit ? (
            <PaymentPanel
              detail={detail}
              busy={busy}
              onPay={(paidOn, note) => run(action('payment', { paidOn, note }))}
              onCancel={(reason) => run(action('cancel', { reason }))}
            />
          ) : null}
          {detail.status === 'confirmed' && !detail.canEdit && detail.paidOn ? (
            <p>{tf('in.paidOn', { date: formatDateTime(detail.paidOn, 'date') })}</p>
          ) : null}
        </section>
      </div>
    </article>
  )
}

function EinvoiceView({
  detail,
  einvoice,
}: {
  detail: IncomingInvoiceDetail
  einvoice: IncomingEinvoiceView
}) {
  const party = (p: IncomingEinvoiceView['seller']) =>
    [
      p.name,
      p.street,
      p.streetExtra,
      [p.postalCode, p.city].filter(Boolean).join(' '),
      p.countryCode,
      p.vatId ? `${t('in.vatId')}: ${p.vatId}` : null,
      p.taxNumber ? `${t('in.taxNumber')}: ${p.taxNumber}` : null,
    ].filter(Boolean)
  const result =
    detail.einvoiceValid === true
      ? { className: 'tag ok', text: t('in.kositValid') }
      : detail.einvoiceValid === false
        ? { className: 'tag', text: t('in.kositInvalid') }
        : { className: 'tag', text: t('in.kositUnchecked') }
  return (
    <details className="einvoice-view" open>
      <summary className="einvoice-summary">
        {t('in.einvoice')}: {detail.einvoiceProfile}{' '}
        <span className={result.className}>{result.text}</span>
      </summary>
      {detail.einvoiceMessages.length ? (
        <ul className="warning-list">
          {detail.einvoiceMessages.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: messages have no id and never reorder
            <li key={i} className={m.level === 'information' ? 'muted' : 'warning'}>
              {m.code ? `${m.code}: ` : ''}
              {m.text}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="einvoice-parties">
        <div>
          <h3>{t('in.seller')}</h3>
          <p>
            {party(einvoice.seller).map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
        </div>
        <div>
          <h3>{t('in.buyer')}</h3>
          <p>
            {party(einvoice.buyer).map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </p>
        </div>
      </div>
      <dl className="facts">
        {[
          [t('in.invoiceNumber'), einvoice.number],
          [t('in.invoiceDate'), formatDateTime(einvoice.issueDate, 'date')],
          [t('in.dueDate'), formatDateTime(einvoice.dueDate, 'date')],
          [t('in.buyerReference'), einvoice.buyerReference],
          [t('in.orderReference'), einvoice.orderReference],
          [
            t('in.period'),
            einvoice.period
              ? `${formatDateTime(einvoice.period.start, 'date')} – ${formatDateTime(einvoice.period.end, 'date')}`
              : einvoice.deliveryDate
                ? formatDateTime(einvoice.deliveryDate, 'date')
                : null,
          ],
          [t('in.iban'), einvoice.payment.iban],
          [t('in.paymentReference'), einvoice.payment.reference],
          [t('in.paymentTerms'), einvoice.payment.terms],
        ]
          .filter(([, v]) => v)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {einvoice.lines.length ? (
        <div className="table-scroll">
          <table className="einvoice-lines">
            <thead>
              <tr>
                <th scope="col" className="einvoice-cell">
                  {t('in.line')}
                </th>
                <th scope="col" className="einvoice-cell num">
                  {t('in.quantity')}
                </th>
                <th scope="col" className="einvoice-cell num">
                  {t('in.price')}
                </th>
                <th scope="col" className="einvoice-cell num">
                  {t('in.net')}
                </th>
              </tr>
            </thead>
            <tbody>
              {einvoice.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are fixed for this invoice
                <tr key={index}>
                  <td className="einvoice-cell">
                    {line.name}
                    {line.description ? (
                      <span className="muted block">{line.description}</span>
                    ) : null}
                  </td>
                  <td className="einvoice-cell num">
                    {line.quantity?.replace('.', ',')} {line.unitCode}
                  </td>
                  <td className="einvoice-cell num">{line.netPrice?.replace('.', ',')}</td>
                  <td className="einvoice-cell num amount">{formatCents(line.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <dl className="receivable-sums">
        {einvoice.vatBreakdown.map((v) => (
          <div key={`${v.category}-${v.rate}`}>
            <dt>
              {tf('in.vatLine', {
                rate: (v.rate ?? '').replace('.', ','),
                category: v.category ?? '',
              })}
            </dt>
            <dd className="amount">{formatCents(v.taxCents)}</dd>
          </div>
        ))}
        <div>
          <dt>{t('in.net')}</dt>
          <dd className="amount">{formatCents(einvoice.totals.netCents)}</dd>
        </div>
        <div className="is-strong">
          <dt>{t('in.gross')}</dt>
          <dd className="amount">{formatCents(einvoice.totals.grossCents)}</dd>
        </div>
        {einvoice.totals.dueCents !== null &&
        einvoice.totals.dueCents !== einvoice.totals.grossCents ? (
          <div>
            <dt>{t('in.due')}</dt>
            <dd className="amount">{formatCents(einvoice.totals.dueCents)}</dd>
          </div>
        ) : null}
      </dl>
      {einvoice.notes.map((note) => (
        <p key={note} className="muted">
          {note}
        </p>
      ))}
    </details>
  )
}

function Text({
  label,
  value,
  onChange,
  type = 'text',
  error,
  inputMode,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'date'
  error?: string | undefined
  inputMode?: 'decimal'
}) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function ReviewForm({
  form,
  update,
  projects,
  areas,
  errors,
  lines,
}: {
  form: Form
  update: (patch: Partial<Form>) => void
  projects: ProjectSummary[]
  areas: BusinessArea[]
  errors: Record<string, string>
  /** Positions of the e-invoice: „Je Rechnungsposition zuweisen“. */
  lines: NonNullable<IncomingInvoiceDetail['einvoice']>['lines']
}) {
  const id = useId()
  const rates = form.taxLines.map((l) => rateOf(l.rate)).filter(Boolean)
  const openPerRate = form.taxLines.map((l) => {
    const rate = rateOf(l.rate)
    const allocated = form.allocations
      .filter((a) => rateOf(a.rate) === rate)
      .reduce((sum, a) => sum + cents(a.net), 0)
    return { rate, rest: cents(l.net) - allocated }
  })
  const setTax = (index: number, patch: Partial<TaxRow>) =>
    update({ taxLines: form.taxLines.map((l, i) => (i === index ? { ...l, ...patch } : l)) })
  const setAllocation = (key: number, patch: Partial<AllocationRow>) =>
    update({ allocations: form.allocations.map((a) => (a.key === key ? { ...a, ...patch } : a)) })
  const sumUp = () => {
    const net = form.taxLines.reduce((s, l) => s + cents(l.net), 0)
    const tax = form.taxLines.reduce((s, l) => s + cents(l.tax), 0)
    update({ net: centsToInput(net), tax: centsToInput(tax), gross: centsToInput(net + tax) })
  }
  const addRest = () => {
    const open = openPerRate.find((r) => r.rest > 0)
    update({
      allocations: [
        ...form.allocations,
        {
          key: ++rowKey,
          target: form.allocations.at(-1)?.target ?? '',
          costType: form.allocations.at(-1)?.costType ?? 'material',
          rate: (open?.rate ?? rates[0] ?? '19').replace('.', ','),
          net: open ? centsToInput(open.rest) : '',
          description: '',
          lineId: null,
        },
      ],
    })
  }
  // One allocation per invoice line (net, rate and text of the line); the target of the first
  // allocation is preset and can be changed per line.
  const usableLines = lines.filter((l) => l.netCents !== null && l.netCents > 0)
  const byLine = () => {
    const target = form.allocations[0]?.target ?? ''
    const costType = form.allocations[0]?.costType ?? 'material'
    update({
      allocations: usableLines.map((l, index) => ({
        key: ++rowKey,
        target,
        costType,
        rate: (l.vatRate ?? rates[0] ?? '0').replace('.', ','),
        net: centsToInput(l.netCents as number),
        description: [l.id ?? String(index + 1), l.name].filter(Boolean).join(' '),
        lineId: l.id ?? String(index + 1),
      })),
    })
  }

  return (
    <div className="review-form">
      <fieldset>
        <legend>{t('in.supplier')}</legend>
        <div className="field">
          <label htmlFor={`${id}-kind`}>{t('in.documentKind')}</label>
          <select
            id={`${id}-kind`}
            className="select"
            value={form.documentKind}
            onChange={(e) => update({ documentKind: e.target.value as Form['documentKind'] })}
          >
            <option value="invoice">{t('in.invoice')}</option>
            <option value="credit_note">{t('in.creditNote')}</option>
          </select>
        </div>
        <Text
          label={t('in.supplierName')}
          value={form.supplierName}
          onChange={(v) => update({ supplierName: v })}
          error={errors.supplierName}
        />
        <div className="row">
          <Text
            label={t('in.vatId')}
            value={form.supplierVatId}
            onChange={(v) => update({ supplierVatId: v })}
          />
          <Text
            label={t('in.taxNumber')}
            value={form.supplierTaxNumber}
            onChange={(v) => update({ supplierTaxNumber: v })}
          />
        </div>
        <Text
          label={t('in.address')}
          value={form.supplierAddress}
          onChange={(v) => update({ supplierAddress: v })}
        />
        <Text
          label={t('in.iban')}
          value={form.supplierIban}
          onChange={(v) => update({ supplierIban: v })}
        />
      </fieldset>
      <fieldset>
        <legend>{t('in.invoice')}</legend>
        <Text
          label={t('in.invoiceNumber')}
          value={form.invoiceNumber}
          onChange={(v) => update({ invoiceNumber: v })}
          error={errors.invoiceNumber}
        />
        <div className="row">
          <Text
            label={t('in.invoiceDate')}
            type="date"
            value={form.invoiceDate}
            onChange={(v) => update({ invoiceDate: v })}
            error={errors.invoiceDate}
          />
          <Text
            label={t('in.dueDate')}
            type="date"
            value={form.dueDate}
            onChange={(v) => update({ dueDate: v })}
            error={errors.dueDate}
          />
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('in.taxLines')}</legend>
        {form.taxLines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, never reordered
          <div key={index} className="row tax-row">
            <Text
              label={t('in.rate')}
              inputMode="decimal"
              value={line.rate}
              onChange={(v) => setTax(index, { rate: v })}
            />
            <Text
              label={t('in.net')}
              inputMode="decimal"
              value={line.net}
              onChange={(v) => setTax(index, { net: v })}
            />
            <Text
              label={t('in.vat')}
              inputMode="decimal"
              value={line.tax}
              onChange={(v) => setTax(index, { tax: v })}
            />
            <button
              type="button"
              className="button ghost small"
              aria-label={tf('in.removeRate', { rate: line.rate })}
              onClick={() => update({ taxLines: form.taxLines.filter((_, i) => i !== index) })}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="button-row">
          <button
            type="button"
            className="button ghost small"
            onClick={() =>
              update({ taxLines: [...form.taxLines, { rate: '19', net: '', tax: '' }] })
            }
          >
            {t('in.addRate')}
          </button>
          <button type="button" className="button ghost small" onClick={sumUp}>
            {t('in.sumUp')}
          </button>
        </div>
        <div className="row">
          <Text
            label={t('in.net')}
            inputMode="decimal"
            value={form.net}
            onChange={(v) => update({ net: v })}
          />
          <Text
            label={t('in.vat')}
            inputMode="decimal"
            value={form.tax}
            onChange={(v) => update({ tax: v })}
          />
          <Text
            label={t('in.gross')}
            inputMode="decimal"
            value={form.gross}
            onChange={(v) => update({ gross: v })}
            error={errors.grossCents}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={form.reverseCharge}
            onChange={(e) => update({ reverseCharge: e.target.checked })}
          />
          <span>{t('in.reverseCharge')}</span>
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('in.allocations')}</legend>
        <p className="hint">{t('in.allocationsHint')}</p>
        {form.allocations.map((a, index) => (
          <div key={a.key} className="allocation">
            <div className="field">
              <label htmlFor={`${id}-t-${a.key}`}>
                {tf('in.target', { n: String(index + 1) })}
              </label>
              <select
                id={`${id}-t-${a.key}`}
                className="select"
                value={a.target}
                onChange={(e) => setAllocation(a.key, { target: e.target.value })}
              >
                <option value="">{t('in.chooseTarget')}</option>
                <optgroup label={t('in.projects')}>
                  {projects.map((p) => (
                    <option key={p.id} value={`p:${p.id}`}>
                      {[p.number, p.name].filter(Boolean).join(' ')}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t('in.businessAreas')}>
                  {areas.map((b) => (
                    <option key={b.id} value={`b:${b.id}`}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor={`${id}-c-${a.key}`}>{t('in.costType')}</label>
                <select
                  id={`${id}-c-${a.key}`}
                  className="select"
                  value={a.costType}
                  onChange={(e) => setAllocation(a.key, { costType: e.target.value as CostType })}
                >
                  {COST_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {t(`in.cost.${c}` as TextKey)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${id}-r-${a.key}`}>{t('in.rate')}</label>
                <select
                  id={`${id}-r-${a.key}`}
                  className="select"
                  value={rateOf(a.rate)}
                  onChange={(e) => setAllocation(a.key, { rate: e.target.value })}
                >
                  {[...new Set([...rates, rateOf(a.rate)])].map((r) => (
                    <option key={r} value={r}>
                      {r.replace('.', ',')} %
                    </option>
                  ))}
                </select>
              </div>
              <Text
                label={t('in.netAmount')}
                inputMode="decimal"
                value={a.net}
                onChange={(v) => setAllocation(a.key, { net: v })}
                error={errors[`allocations.${index}`]}
              />
            </div>
            <div className="row">
              <Text
                label={t('in.description')}
                value={a.description}
                onChange={(v) => setAllocation(a.key, { description: v })}
              />
              <button
                type="button"
                className="button ghost small"
                onClick={() =>
                  update({ allocations: form.allocations.filter((x) => x.key !== a.key) })
                }
              >
                {t('in.removeAllocation')}
              </button>
            </div>
          </div>
        ))}
        <ul className="muted allocation-rest">
          {openPerRate
            .filter((r) => r.rest !== 0)
            .map((r) => (
              <li key={r.rate}>
                {tf(r.rest > 0 ? 'in.rest' : 'in.over', {
                  rate: r.rate.replace('.', ','),
                  amount: formatCents(Math.abs(r.rest)),
                })}
              </li>
            ))}
        </ul>
        <div className="button-row">
          <button type="button" className="button ghost small" onClick={addRest}>
            {t('in.addAllocation')}
          </button>
          {usableLines.length > 1 ? (
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                if (form.allocations.length && !window.confirm(t('in.byLineConfirm'))) return
                byLine()
              }}
            >
              {tf('in.byLine', { n: String(usableLines.length) })}
            </button>
          ) : null}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor={`${id}-note`}>{t('in.note')}</label>
        <textarea
          id={`${id}-note`}
          rows={2}
          value={form.note}
          onChange={(e) => update({ note: e.target.value })}
        />
      </div>
    </div>
  )
}

function ReadOnlyData({ detail }: { detail: IncomingInvoiceDetail }) {
  return (
    <>
      <dl className="facts">
        {[
          [
            t('in.documentKind'),
            detail.documentKind === 'credit_note' ? t('in.creditNote') : t('in.invoice'),
          ],
          [t('in.supplierName'), detail.supplierName],
          [t('in.vatId'), detail.supplierVatId],
          [t('in.taxNumber'), detail.supplierTaxNumber],
          [t('in.address'), detail.supplierAddress],
          [t('in.iban'), detail.supplierIban],
          [t('in.invoiceNumber'), detail.invoiceNumber],
          [t('in.invoiceDate'), formatDateTime(detail.invoiceDate, 'date')],
          [t('in.dueDate'), formatDateTime(detail.dueDate, 'date')],
          [t('in.reverseCharge'), detail.reverseCharge ? t('in.yes') : null],
          [t('in.note'), detail.note],
        ]
          .filter(([, v]) => v)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      <dl className="receivable-sums">
        {detail.taxLines.map((l) => (
          <div key={l.ratePercent}>
            <dt>
              {tf('in.vatOn', {
                rate: l.ratePercent.replace('.', ','),
                net: formatCents(l.netCents),
              })}
            </dt>
            <dd className="amount">{formatCents(l.taxCents)}</dd>
          </div>
        ))}
        <div>
          <dt>{t('in.net')}</dt>
          <dd className="amount">{formatCents(detail.netCents)}</dd>
        </div>
        <div className="is-strong">
          <dt>{t('in.gross')}</dt>
          <dd className="amount">{formatCents(detail.grossCents)}</dd>
        </div>
      </dl>
      {detail.allocations.length ? (
        <>
          <h3>{t('in.allocations')}</h3>
          <ul className="list">
            {detail.allocations.map((a) => (
              <li key={a.id} className="list-row">
                <span>
                  <strong>{a.projectName ?? a.businessAreaName}</strong>
                  <span className="muted block">
                    {t(`in.cost.${a.costType}` as TextKey)} · {a.ratePercent.replace('.', ',')} %
                    {a.description ? ` · ${a.description}` : ''}
                  </span>
                </span>
                <span className="amount">{formatCents(a.netCents)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  )
}

function PaymentPanel({
  detail,
  busy,
  onPay,
  onCancel,
}: {
  detail: IncomingInvoiceDetail
  busy: boolean
  onPay: (paidOn: string | null, note: string | null) => void
  onCancel: (reason: string) => void
}) {
  const id = useId()
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  return (
    <div className="incoming-payment">
      <h3>{t('in.payment')}</h3>
      {detail.paidOn ? (
        <>
          <p>
            {tf('in.paidOn', { date: formatDateTime(detail.paidOn, 'date') })}
            {detail.paymentNote ? ` · ${detail.paymentNote}` : ''}
          </p>
          <button
            type="button"
            className="button ghost auto"
            disabled={busy}
            onClick={() => onPay(null, null)}
          >
            {t('in.markOpen')}
          </button>
        </>
      ) : (
        <>
          <div className="row">
            <div className="field">
              <label htmlFor={`${id}-paid`}>{t('in.paidOnLabel')}</label>
              <input
                id={`${id}-paid`}
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`${id}-note`}>{t('in.paymentNote')}</label>
              <input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <button
            type="button"
            className="button primary auto"
            disabled={busy || !paidOn}
            onClick={() => onPay(paidOn, note.trim() || null)}
          >
            {t('in.markPaid')}
          </button>
        </>
      )}
      <div className="button-row">
        <button
          type="button"
          className="button ghost auto danger"
          disabled={busy}
          onClick={() => {
            const reason = window.prompt(t('in.cancelReason'))
            if (reason?.trim()) onCancel(reason)
          }}
        >
          {t('in.cancel')}
        </button>
      </div>
    </div>
  )
}
