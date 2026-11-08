import type {
  DocumentDetail,
  DocumentItem,
  EditablePositionType,
  Me,
  TaxRateSummary,
  UnitSummary,
} from '@opc/schemas'
import { PRICED_POSITION_TYPES, TAX_MODES } from '@opc/schemas/constants'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { ApiError, api, apiWithEtag } from '../api'
import { centsToInput, formatCents, formatQuantity, parseEuro } from '../format'
import { Field, FormError, optional, SelectField, TextArea, useForm, value } from '../forms'
import { type TextKey, t } from '../i18n'
import type { Navigate } from '../router'
import { documentLabel, StatusChip } from './documents'

type Doc = DocumentDetail
type Apply = (result: { data: Doc; etag: string | null }) => void

const isPriced = (type: string) => (PRICED_POSITION_TYPES as readonly string[]).includes(type)
const NOT_COUNTED = new Set(['alternative', 'optional'])

/** Document editor: header, positions (Leistungsverzeichnis) and totals of a draft. */
export function DocumentScreen({ me, id, navigate }: { me: Me; id: string; navigate: Navigate }) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [units, setUnits] = useState<UnitSummary[]>([])
  const [rates, setRates] = useState<TaxRateSummary[]>([])

  const apply: Apply = useCallback(({ data, etag: tag }) => {
    setDoc(data)
    setEtag(tag)
  }, [])

  useEffect(() => {
    apiWithEtag<Doc>('GET', `/api/v1/documents/${id}`)
      .then(apply)
      .catch((err: ApiError) => setError(err.message))
    api<UnitSummary[]>('GET', '/api/v1/units')
      .then(setUnits)
      .catch(() => undefined)
    api<TaxRateSummary[]>('GET', '/api/v1/tax-rates')
      .then(setRates)
      .catch(() => undefined)
  }, [id, apply])

  if (error && !doc) return <FormError>{error}</FormError>
  if (!doc) return <p className="muted">{t('common.loading')}</p>

  const editable = doc.status === 'draft' && me.permissions.includes('document.write')
  const backToProject = () =>
    navigate({ view: 'project', id: doc.project.id, section: 'documents' })

  const remove = async () => {
    if (!window.confirm(t('doc.deleteDraftConfirm'))) return
    try {
      await api('DELETE', `/api/v1/documents/${doc.id}`)
      backToProject()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  return (
    <section aria-labelledby="document-title">
      <a
        className="back"
        href={`/projekte/${doc.project.id}/dokumente`}
        onClick={(e) => {
          e.preventDefault()
          backToProject()
        }}
      >
        ← {doc.project.number ? `${doc.project.number} · ` : ''}
        {doc.project.name}
      </a>
      <div className="section-head">
        <h1 id="document-title">{documentLabel(doc)}</h1>
        <StatusChip status={doc.status} />
      </div>
      <p className="muted">
        {doc.number ?? t('documents.draftNoNumber')}
        {doc.contact ? ` · ${doc.contact.displayName}` : ''}
      </p>
      {doc.status === 'draft' ? (
        <p className="hint">{t('doc.finalizeLater')}</p>
      ) : (
        <p className="notice inline" role="status">
          {t('doc.locked')}
        </p>
      )}
      <FormError>{error}</FormError>

      <HeaderForm doc={doc} etag={etag} editable={editable} apply={apply} />
      <Positions doc={doc} editable={editable} units={units} rates={rates} apply={apply} />
      <Totals doc={doc} />

      {editable ? (
        <button type="button" className="button ghost danger" onClick={remove}>
          {t('doc.deleteDraft')}
        </button>
      ) : null}
    </section>
  )
}

function HeaderForm({
  doc,
  etag,
  editable,
  apply,
}: {
  doc: Doc
  etag: string | null
  editable: boolean
  apply: Apply
}) {
  const [saved, setSaved] = useState(false)
  const billed = doc.type === 'invoice' || doc.type === 'credit_note'
  const form = useForm(
    async (data) => {
      setSaved(false)
      const days = value(data, 'paymentDueDays')
      return apiWithEtag<Doc>(
        'PATCH',
        `/api/v1/documents/${doc.id}`,
        {
          subject: optional(data, 'subject') ?? null,
          documentDate: value(data, 'documentDate'),
          placeOfPerformance: optional(data, 'placeOfPerformance') ?? null,
          introText: optional(data, 'introText') ?? null,
          closingText: optional(data, 'closingText') ?? null,
          discountPercent: optional(data, 'discountPercent') ?? null,
          taxMode: value(data, 'taxMode'),
          ...(billed
            ? {
                serviceFrom: optional(data, 'serviceFrom') ?? null,
                serviceTo: optional(data, 'serviceTo') ?? null,
                paymentDueDays: days === '' ? null : Number(days),
              }
            : {}),
        },
        etag,
      )
    },
    (result) => {
      apply(result)
      setSaved(true)
    },
  )
  return (
    <details className="panel" open={editable}>
      <summary>
        <h2 className="summary-title">{t('doc.header')}</h2>
      </summary>
      <form onSubmit={form.onSubmit} noValidate>
        <fieldset disabled={!editable}>
          <FormError>{form.error}</FormError>
          <Field
            label={t('doc.subject')}
            name="subject"
            defaultValue={doc.subject ?? ''}
            error={form.fieldErrors.subject}
          />
          <div className="row">
            <Field
              label={t('doc.date')}
              name="documentDate"
              type="date"
              defaultValue={doc.documentDate}
              error={form.fieldErrors.documentDate}
            />
            <SelectField
              label={t('doc.taxMode')}
              name="taxMode"
              defaultValue={doc.taxMode}
              options={TAX_MODES.map((m) => ({
                value: m,
                label: t(`doc.taxMode.${m}` as TextKey),
              }))}
            />
          </div>
          <Field
            label={t('doc.place')}
            name="placeOfPerformance"
            defaultValue={doc.placeOfPerformance ?? ''}
            error={form.fieldErrors.placeOfPerformance}
          />
          {billed ? (
            <div className="row">
              <Field
                label={t('doc.serviceFrom')}
                name="serviceFrom"
                type="date"
                defaultValue={doc.serviceFrom ?? undefined}
                error={form.fieldErrors.serviceFrom}
              />
              <Field
                label={t('doc.serviceTo')}
                name="serviceTo"
                type="date"
                defaultValue={doc.serviceTo ?? undefined}
                error={form.fieldErrors.serviceTo}
              />
              <Field
                label={t('doc.paymentDays')}
                name="paymentDueDays"
                inputMode="numeric"
                defaultValue={doc.paymentDueDays === null ? '' : String(doc.paymentDueDays)}
                error={form.fieldErrors.paymentDueDays}
              />
            </div>
          ) : null}
          <Field
            label={t('doc.discount')}
            name="discountPercent"
            inputMode="decimal"
            defaultValue={doc.discountPercent?.replace('.', ',') ?? ''}
            error={form.fieldErrors.discountPercent}
          />
          <TextArea label={t('doc.intro')} name="introText" defaultValue={doc.introText} />
          <TextArea label={t('doc.closing')} name="closingText" defaultValue={doc.closingText} />
          {editable ? (
            <div className="button-row">
              <button type="submit" className="button primary auto" disabled={form.busy}>
                {t('common.save')}
              </button>
              {saved ? (
                <span className="success" role="status">
                  {t('doc.saved')}
                </span>
              ) : null}
            </div>
          ) : null}
        </fieldset>
      </form>
    </details>
  )
}

function Positions({
  doc,
  editable,
  units,
  rates,
  apply,
}: {
  doc: Doc
  editable: boolean
  units: UnitSummary[]
  rates: TaxRateSummary[]
  apply: Apply
}) {
  const [adding, setAdding] = useState<EditablePositionType | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (call: () => Promise<{ data: Doc; etag: string | null }>) => {
    setError(null)
    try {
      apply(await call())
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  const move = (item: DocumentItem, direction: 'up' | 'down') =>
    run(() =>
      apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/items/${item.id}/move`, { direction }),
    )
  const remove = (item: DocumentItem) => {
    if (!window.confirm(t('doc.deleteItemConfirm'))) return
    run(() => apiWithEtag<Doc>('DELETE', `/api/v1/documents/${doc.id}/items/${item.id}`))
  }

  const titles = doc.items.filter((i) => i.positionType === 'title')

  return (
    <div className="panel">
      <h2>{t('doc.positions')}</h2>
      <FormError>{error}</FormError>
      {!doc.items.length ? <p className="muted">{t('doc.positionsEmpty')}</p> : null}
      {doc.items.length ? (
        <ol className="positions">
          {doc.items.map((item) => (
            <li
              key={item.id}
              className={`position position--${item.positionType}`}
              style={{
                paddingInlineStart: `calc(${item.level} * var(--space-4) + var(--space-2))`,
              }}
            >
              {editingId === item.id ? (
                <ItemForm
                  doc={doc}
                  item={item}
                  positionType={item.positionType as EditablePositionType}
                  units={units}
                  rates={rates}
                  titles={titles}
                  onDone={(result) => {
                    apply(result)
                    setEditingId(null)
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <PositionView item={item} subtotal={doc.totals.titleSubtotals[item.id]} />
                  {editable ? (
                    <span className="actions">
                      <button
                        type="button"
                        className="button ghost icon"
                        aria-label={`${t('common.edit')}: ${item.shortText ?? t('doc.pos.text')}`}
                        onClick={() => setEditingId(item.id)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="button ghost icon"
                        aria-label={t('common.up')}
                        onClick={() => move(item, 'up')}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="button ghost icon"
                        aria-label={t('common.down')}
                        onClick={() => move(item, 'down')}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="button ghost icon danger"
                        aria-label={t('common.delete')}
                        onClick={() => remove(item)}
                      >
                        ✕
                      </button>
                    </span>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {editable && adding ? (
        <ItemForm
          doc={doc}
          positionType={adding}
          units={units}
          rates={rates}
          titles={titles}
          onDone={(result) => {
            apply(result)
            setAdding(null)
          }}
          onCancel={() => setAdding(null)}
        />
      ) : null}
      {editable && !adding ? (
        <button
          type="button"
          className="button ghost small apply-measurements"
          onClick={() =>
            run(() => apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/apply-measurements`))
          }
        >
          {t('doc.applyMeasurements')}
        </button>
      ) : null}
      {editable && !adding ? (
        <fieldset className="add-bar">
          <legend className="muted">{t('doc.addPosition')}</legend>
          {(['title', 'item', 'lump_sum', 'optional', 'alternative', 'text'] as const).map(
            (type) => (
              <button
                key={type}
                type="button"
                className="button ghost small"
                onClick={() => setAdding(type)}
              >
                + {t(`doc.pos.${type}` as TextKey)}
              </button>
            ),
          )}
        </fieldset>
      ) : null}
    </div>
  )
}

function PositionView({ item, subtotal }: { item: DocumentItem; subtotal: number | undefined }) {
  if (item.positionType === 'title') {
    return (
      <div className="position-main">
        <strong>
          {item.oz} {item.shortText}
        </strong>
        <span className="amount">{formatCents(subtotal ?? 0)}</span>
      </div>
    )
  }
  if (!isPriced(item.positionType)) {
    return <p className="position-text pre">{item.longText ?? item.shortText}</p>
  }
  const notCounted = NOT_COUNTED.has(item.positionType)
  return (
    <div className="position-main">
      <span>
        <span className="oz">{item.oz}</span> {item.shortText}
        {item.positionType !== 'item' ? (
          <span className="tag">
            {t(`doc.pos.${item.positionType}` as TextKey)}
            {notCounted ? ` · ${t('doc.notCounted')}` : ''}
          </span>
        ) : null}
        {item.fromMeasurement ? <span className="tag ok">{t('doc.fromMeasurement')}</span> : null}
        {item.longText ? <span className="hint pre block">{item.longText}</span> : null}
        <span className="muted block calc">
          {formatQuantity(item.quantity)} {item.unit?.symbol} × {formatCents(item.unitPriceCents)}
          {item.discountPercent ? ` − ${formatQuantity(item.discountPercent)} %` : ''}
          {item.taxRatePercent ? ` · ${formatQuantity(item.taxRatePercent)} % USt` : ''}
        </span>
      </span>
      <span className={`amount${notCounted ? ' muted' : ''}`}>{formatCents(item.totalCents)}</span>
    </div>
  )
}

function ItemForm({
  doc,
  item,
  positionType,
  units,
  rates,
  titles,
  onDone,
  onCancel,
}: {
  doc: Doc
  item?: DocumentItem
  positionType: EditablePositionType
  units: UnitSummary[]
  rates: TaxRateSummary[]
  titles: DocumentItem[]
  onDone: Apply
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const priced = isPriced(positionType)
  const lumpSum = positionType === 'lump_sum'
  const ratePercents = [...new Set(rates.map((r) => r.percent))]
  const lastTitle = titles.at(-1)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const price = priced ? parseEuro(value(data, 'unitPrice')) : null
    if (Number.isNaN(price)) {
      setFieldErrors({ unitPriceCents: t('doc.invalidAmount') })
      return
    }
    const body: Record<string, unknown> = {
      shortText: optional(data, 'shortText') ?? null,
      longText: optional(data, 'longText') ?? null,
    }
    if (priced) {
      Object.assign(body, {
        unitPriceCents: price ?? 0,
        discountPercent: optional(data, 'discountPercent') ?? null,
        taxRatePercent: value(data, 'taxRatePercent') || null,
      })
      if (!lumpSum)
        Object.assign(body, { quantity: value(data, 'quantity'), unitId: value(data, 'unitId') })
    }
    if (!item) {
      body.positionType = positionType
      const parent = value(data, 'parentId')
      if (parent) body.parentId = parent
    }
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      onDone(
        item
          ? await apiWithEtag<Doc>('PATCH', `/api/v1/documents/${doc.id}/items/${item.id}`, body)
          : await apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/items`, body),
      )
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFieldErrors(err.fieldErrors)
      } else setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="item-form" onSubmit={submit} noValidate>
      <h3>
        {item ? t('common.edit') : t('common.add')}: {t(`doc.pos.${positionType}` as TextKey)}
      </h3>
      <FormError>{error}</FormError>
      {!item &&
      titles.length &&
      (positionType !== 'title' || titles.some((ti) => ti.level === 0)) ? (
        <SelectField
          label={t('doc.parent')}
          name="parentId"
          defaultValue={positionType === 'title' ? '' : (lastTitle?.id ?? '')}
          options={[
            { value: '', label: t('doc.topLevel') },
            ...titles
              .filter((ti) => positionType !== 'title' || ti.level === 0)
              .map((ti) => ({ value: ti.id, label: `${ti.oz} ${ti.shortText ?? ''}` })),
          ]}
          error={fieldErrors.parentId}
        />
      ) : null}
      {positionType !== 'text' ? (
        <Field
          label={positionType === 'title' ? t('doc.pos.title') : t('doc.shortText')}
          name="shortText"
          required
          defaultValue={item?.shortText ?? ''}
          error={fieldErrors.shortText}
        />
      ) : null}
      {positionType !== 'title' ? (
        <TextArea
          label={positionType === 'text' ? t('doc.pos.text') : t('doc.longText')}
          name="longText"
          defaultValue={item?.longText}
          error={fieldErrors.longText}
        />
      ) : null}
      {priced ? (
        <>
          <div className="row">
            {!lumpSum ? (
              <>
                <Field
                  label={t('doc.quantity')}
                  name="quantity"
                  inputMode="decimal"
                  required
                  defaultValue={formatQuantity(item?.quantity)}
                  error={fieldErrors.quantity}
                />
                <SelectField
                  label={t('doc.unit')}
                  name="unitId"
                  defaultValue={item?.unit?.id ?? units.find((u) => u.symbol === 'Stk.')?.id}
                  options={units.map((u) => ({ value: u.id, label: `${u.symbol} – ${u.name}` }))}
                  error={fieldErrors.unitId}
                />
              </>
            ) : null}
            <Field
              label={lumpSum ? t('doc.lumpPrice') : t('doc.unitPrice')}
              name="unitPrice"
              inputMode="decimal"
              defaultValue={centsToInput(item?.unitPriceCents)}
              error={fieldErrors.unitPriceCents}
            />
          </div>
          <div className="row">
            <Field
              label={t('doc.itemDiscount')}
              name="discountPercent"
              inputMode="decimal"
              defaultValue={formatQuantity(item?.discountPercent)}
              error={fieldErrors.discountPercent}
            />
            {ratePercents.length ? (
              <SelectField
                label={t('doc.taxRate')}
                name="taxRatePercent"
                defaultValue={item?.taxRatePercent ?? rates.find((r) => r.isDefault)?.percent}
                options={ratePercents.map((p) => ({ value: p, label: `${formatQuantity(p)} %` }))}
                error={fieldErrors.taxRatePercent}
              />
            ) : null}
          </div>
        </>
      ) : null}
      <div className="button-row">
        <button type="submit" className="button primary auto" disabled={busy}>
          {item ? t('common.save') : t('common.add')}
        </button>
        <button type="button" className="button ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}

function Totals({ doc }: { doc: Doc }) {
  const totals = doc.totals
  const rows: { key: string; label: React.ReactNode; value: string; grand?: boolean }[] = [
    { key: 'net', label: t('doc.net'), value: formatCents(totals.itemsNetCents) },
  ]
  if (totals.discountCents) {
    rows.push(
      {
        key: 'discount',
        label: `${t('doc.discountLine')} ${formatQuantity(doc.discountPercent)} %`,
        value: `− ${formatCents(totals.discountCents)}`,
      },
      { key: 'netAfter', label: t('doc.netAfterDiscount'), value: formatCents(totals.netCents) },
    )
  }
  for (const line of totals.taxLines) {
    rows.push({
      key: `${line.category}-${line.ratePercent}`,
      label: (
        <>
          {t('doc.vat')} {formatQuantity(line.ratePercent.replace(/\.?0+$/, ''))} % ({t('doc.net')}{' '}
          {formatCents(line.netCents)})
          {line.exemptionReason ? <span className="hint block">{line.exemptionReason}</span> : null}
        </>
      ),
      value: formatCents(line.taxCents),
    })
  }
  rows.push({
    key: 'gross',
    label: t('doc.gross'),
    value: formatCents(totals.grossCents),
    grand: true,
  })
  return (
    <div className="panel">
      <dl className="totals">
        {rows.map((row) => (
          <div key={row.key} className={row.grand ? 'grand' : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
