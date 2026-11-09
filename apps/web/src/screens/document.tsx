import type {
  CatalogItem,
  ContactSummary,
  DocumentDetail,
  DocumentItem,
  EditablePositionType,
  FinalizeCheck,
  Me,
  Page,
  SupplierArticle,
  TaxRateSummary,
  UnitSummary,
} from '@opc/schemas'
import {
  CHANGE_ORDER_BASES,
  COST_KINDS,
  PRICED_POSITION_TYPES,
  TAX_MODES,
} from '@opc/schemas/constants'
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { ApiError, api, apiWithEtag } from '../api'
import {
  centsToInput,
  formatCents,
  formatDateTime,
  formatInputNumber,
  formatQuantity,
  parseEuro,
} from '../format'
import { Field, FormError, optional, SelectField, TextArea, useForm, value } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import type { Navigate } from '../router'
import { articlePrice } from './catalog'
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
        {doc.status === 'cancelled' && doc.number ? (
          <s className="locked-number">{doc.number}</s>
        ) : (
          (doc.number ?? t('documents.draftNoNumber'))
        )}
        {doc.contact ? ` · ${doc.contact.displayName}` : ''}
      </p>
      {doc.cancelledBy ? (
        <p className="notice inline cancelled-notice" role="status">
          {t('doc.cancelledNotice')
            .replace('{number}', doc.number ?? '')
            .replace('{cancellation}', doc.cancelledBy.number)}{' '}
          <a
            href={`/dokumente/${doc.cancelledBy.id}`}
            onClick={(e) => {
              e.preventDefault()
              navigate({ view: 'document', id: (doc.cancelledBy as { id: string }).id })
            }}
          >
            {t('doc.openCancellation')}
          </a>
        </p>
      ) : doc.cancels?.number ? (
        <p className="notice inline" role="status">
          {t('doc.cancels').replace('{number}', doc.cancels.number)}
        </p>
      ) : null}
      {doc.status !== 'draft' && !doc.cancelledBy ? (
        <p className="notice inline" role="status">
          {t('doc.locked')}
        </p>
      ) : null}
      <FormError>{error}</FormError>

      {doc.type === 'quote' || doc.type === 'change_order' ? (
        <ChangeOrderSwitch doc={doc} editable={editable} apply={apply} />
      ) : null}
      <DocumentActions
        doc={doc}
        canWrite={me.permissions.includes('document.write')}
        canFinalize={me.permissions.includes('document.finalize')}
        apply={apply}
        navigate={navigate}
      />

      <HeaderForm doc={doc} etag={etag} editable={editable} apply={apply} />
      <Positions
        doc={doc}
        editable={editable}
        units={units}
        rates={rates}
        apply={apply}
        canUseCatalog={me.permissions.includes('catalog.read')}
      />
      <Totals doc={doc} />
      {me.permissions.includes('price.view') ? <InternalCalculation doc={doc} /> : null}

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
  const offer = ['quote', 'cost_estimate', 'change_order'].includes(doc.type)
  const [contacts, setContacts] = useState<ContactSummary[]>([])
  useEffect(() => {
    if (!editable) return
    api<Page<ContactSummary>>('GET', '/api/v1/contacts?limit=100')
      .then((page) => setContacts(page.items))
      .catch(() => undefined)
  }, [editable])
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
          contactId: value(data, 'contactId') || null,
          ...(offer ? { validUntil: optional(data, 'validUntil') ?? null } : {}),
          ...(billed
            ? {
                serviceFrom: optional(data, 'serviceFrom') ?? null,
                serviceTo: optional(data, 'serviceTo') ?? null,
                paymentDueDays: days === '' ? null : Number(days),
                cashDiscountPercent: optional(data, 'cashDiscountPercent') ?? null,
                cashDiscountDays: optional(data, 'cashDiscountDays')
                  ? Number(value(data, 'cashDiscountDays'))
                  : null,
                retentionPercent: optional(data, 'retentionPercent') ?? null,
                constructionLevyPercent: optional(data, 'constructionLevyPercent') ?? null,
                ...(doc.invoiceKind === 'progress'
                  ? { progressBillingMode: value(data, 'progressBillingMode') }
                  : {}),
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
          <SelectField
            label={t('doc.recipient')}
            name="contactId"
            defaultValue={doc.contact?.id ?? ''}
            options={[
              { value: '', label: t('common.none') },
              ...(doc.contact && !contacts.some((c) => c.id === doc.contact?.id)
                ? [{ value: doc.contact.id, label: doc.contact.displayName }]
                : []),
              ...contacts.map((c) => ({ value: c.id, label: c.displayName })),
            ]}
            error={form.fieldErrors.contactId}
          />
          <Field
            label={t('doc.place')}
            name="placeOfPerformance"
            defaultValue={doc.placeOfPerformance ?? ''}
            error={form.fieldErrors.placeOfPerformance}
          />
          {offer ? (
            <Field
              label={t('q.validUntil')}
              name="validUntil"
              type="date"
              defaultValue={doc.validUntil ?? undefined}
              error={form.fieldErrors.validUntil}
            />
          ) : null}
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
          {billed ? (
            <div className="row">
              <Field
                label={t('inv.cashDiscountPercent')}
                name="cashDiscountPercent"
                inputMode="decimal"
                defaultValue={doc.cashDiscountPercent?.replace('.', ',') ?? ''}
                error={form.fieldErrors.cashDiscountPercent}
              />
              <Field
                label={t('inv.cashDiscountDays')}
                name="cashDiscountDays"
                inputMode="numeric"
                defaultValue={doc.cashDiscountDays === null ? '' : String(doc.cashDiscountDays)}
                error={form.fieldErrors.cashDiscountDays}
              />
              <Field
                label={t('inv.retention')}
                name="retentionPercent"
                inputMode="decimal"
                defaultValue={doc.retentionPercent?.replace('.', ',') ?? ''}
                error={form.fieldErrors.retentionPercent}
              />
              <Field
                label={t('inv.levy')}
                name="constructionLevyPercent"
                inputMode="decimal"
                defaultValue={doc.constructionLevyPercent?.replace('.', ',') ?? ''}
                error={form.fieldErrors.constructionLevyPercent}
              />
            </div>
          ) : null}
          {doc.invoiceKind === 'progress' ? (
            <SelectField
              label={t('inv.mode')}
              name="progressBillingMode"
              defaultValue={doc.progressBillingMode ?? 'cumulative'}
              options={[
                { value: 'cumulative', label: t('inv.mode.cumulative') },
                { value: 'individual', label: t('inv.mode.individual') },
              ]}
            />
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
  canUseCatalog,
}: {
  doc: Doc
  editable: boolean
  units: UnitSummary[]
  rates: TaxRateSummary[]
  apply: Apply
  canUseCatalog: boolean
}) {
  const [adding, setAdding] = useState<EditablePositionType | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [calcId, setCalcId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
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
              {calcId === item.id ? (
                <CalculationForm
                  doc={doc}
                  item={item}
                  units={units}
                  onDone={(result) => {
                    apply(result)
                    setCalcId(null)
                  }}
                  onCancel={() => setCalcId(null)}
                />
              ) : editingId === item.id ? (
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
                      {isPriced(item.positionType) ? (
                        <button
                          type="button"
                          className="button ghost small"
                          aria-label={`${t('q.calc')}: ${item.shortText ?? ''}`}
                          onClick={() => setCalcId(item.id)}
                        >
                          {t('q.calc')}
                        </button>
                      ) : null}
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
      {editable && picking ? (
        <CatalogPicker doc={doc} titles={titles} apply={apply} onClose={() => setPicking(false)} />
      ) : null}
      {editable && !adding && !picking && canUseCatalog ? (
        <button type="button" className="button ghost small" onClick={() => setPicking(true)}>
          {t('c.insert')}
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
        {item.calculation ? (
          <span className="tag calc-tag">
            {t('q.calc')}
            {item.calculation.marginPercent
              ? ` · ${t('q.margin')} ${formatQuantity(item.calculation.marginPercent)} %`
              : ''}
          </span>
        ) : null}
        {item.longText ? <span className="hint pre block">{item.longText}</span> : null}
        {item.cumulativeQuantity !== null || item.previouslyBilledQuantity !== null ? (
          <span className="hint block">
            {[
              item.cumulativeQuantity !== null
                ? `${t('inv.measured')} ${formatQuantity(item.cumulativeQuantity, item.unit?.decimals)} ${item.unit?.symbol ?? ''}`
                : null,
              item.previouslyBilledQuantity !== null
                ? `${t('inv.billedBefore')} ${formatQuantity(item.previouslyBilledQuantity, item.unit?.decimals)} ${item.unit?.symbol ?? ''}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
        <span className="muted block calc">
          {formatQuantity(item.quantity, item.unit?.decimals)} {item.unit?.symbol} ×{' '}
          {formatCents(item.unitPriceCents)}
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
                  defaultValue={formatInputNumber(item?.quantity)}
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
              hint={item?.costLines.length ? t('q.calcFromCalc') : undefined}
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
              defaultValue={formatInputNumber(item?.discountPercent)}
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
    label: totals.deductions.length ? t('inv.restGross') : t('doc.gross'),
    value: formatCents(totals.grossCents),
    grand: true,
  })
  if (totals.retentionCents) {
    rows.push({
      key: 'retention',
      label: `${t('inv.retention')} ${formatQuantity(doc.retentionPercent)} %`,
      value: `− ${formatCents(totals.retentionCents)}`,
    })
  }
  if (totals.constructionLevyCents) {
    rows.push({
      key: 'levy',
      label: `${t('inv.levy')} ${formatQuantity(doc.constructionLevyPercent)} %`,
      value: `− ${formatCents(totals.constructionLevyCents)}`,
    })
  }
  if (totals.retentionCents || totals.constructionLevyCents) {
    rows.push({
      key: 'payable',
      label: t('inv.payable'),
      value: formatCents(totals.payableCents),
      grand: true,
    })
  }
  return (
    <div className="panel">
      {totals.deductions.length ? <DeductionTable doc={doc} /> : null}
      <dl className="totals">
        {rows.map((row) => (
          <div key={row.key} className={row.grand ? 'grand' : undefined}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {doc.legalNotes.length ? (
        <ul className="legal-notes">
          {doc.legalNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Abschlagsaufstellung (§ 14 Abs. 5 UStG): Gesamtleistung − Abschläge = Restbetrag. */
export function DeductionTable({ doc }: { doc: Doc }) {
  const { performance, deductions } = doc.totals
  const label = (d: Doc['totals']['deductions'][number]) =>
    `${documentLabel({ type: 'invoice', invoiceKind: d.invoiceKind, progressNo: d.progressNo, changeOrder: null })} ${d.number ?? ''} ${t('inv.of')} ${formatDateTime(d.documentDate, 'date')}`
  const row = (
    key: string,
    name: string,
    net: number,
    tax: number,
    gross: number,
    sign = '',
    rest = false,
  ) => (
    <tr key={key} className={`data-row${rest ? ' rest-row' : ''}`}>
      <th scope="row" className="row-label">
        {name}
      </th>
      {(
        [
          ['inv.net', net],
          ['inv.tax', tax],
          ['inv.gross', gross],
        ] as const
      ).map(([label, cents]) => (
        <td key={label} className="amount-cell" data-label={t(label)}>
          {sign}
          {formatCents(cents)}
        </td>
      ))}
    </tr>
  )
  return (
    <table className="deduction-table">
      <caption>{t('inv.deductionTitle')}</caption>
      <thead>
        <tr>
          <td />
          <th scope="col" className="col-head">
            {t('inv.net')}
          </th>
          <th scope="col" className="col-head">
            {t('inv.tax')}
          </th>
          <th scope="col" className="col-head">
            {t('inv.gross')}
          </th>
        </tr>
      </thead>
      <tbody>
        {row(
          'performance',
          t('inv.performance'),
          performance.netCents,
          performance.taxCents,
          performance.grossCents,
        )}
        {deductions.map((d) =>
          row(d.documentId, label(d), d.netCents, d.taxCents, d.grossCents, '− '),
        )}
      </tbody>
      <tfoot>
        {row(
          'rest',
          t('inv.rest'),
          doc.totals.netCents,
          doc.totals.taxCents,
          doc.totals.grossCents,
          '',
          true,
        )}
      </tfoot>
    </table>
  )
}

// ---- Schalter „Nachtragsangebot“ ----------------------------------------------------------------

function ChangeOrderSwitch({
  doc,
  editable,
  apply,
}: {
  doc: Doc
  editable: boolean
  apply: Apply
}) {
  const isChangeOrder = doc.type === 'change_order'
  const [asking, setAsking] = useState(false)
  const [basis, setBasis] = useState<string>('additional_work')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const disabled = !editable || !doc.canConvertToChangeOrder || busy

  const convert = async (to: 'quote' | 'change_order') => {
    setBusy(true)
    setError(null)
    try {
      apply(
        await apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/convert`, {
          to,
          ...(to === 'change_order' ? { basis, reason: reason.trim() || undefined } : {}),
        }),
      )
      setAsking(false)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel switch-panel">
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          aria-checked={isChangeOrder || asking}
          checked={isChangeOrder || asking}
          disabled={disabled}
          aria-describedby="co-switch-hint"
          onChange={(e) => {
            if (e.target.checked) setAsking(true)
            else if (isChangeOrder) convert('quote')
            else setAsking(false)
          }}
        />
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="switch-label">{t('q.changeOrderSwitch')}</span>
      </label>
      <p id="co-switch-hint" className="hint">
        {doc.canConvertToChangeOrder || isChangeOrder
          ? t('q.changeOrderSwitchHint')
          : t('q.changeOrderNeedsContract')}
      </p>
      {isChangeOrder && doc.changeOrderInfo ? (
        <p className="muted">
          {t('q.changeOrderInfo')} {doc.changeOrderInfo.contractLabel}
          {doc.changeOrder ? ` · ${t(`doc.basis.${doc.changeOrder.basis}` as TextKey)}` : ''}
          {doc.changeOrderInfo.reason ? ` · ${doc.changeOrderInfo.reason}` : ''}
        </p>
      ) : null}
      {asking && !isChangeOrder ? (
        <div className="stack">
          <SelectField
            label={t('doc.basis')}
            name="basis"
            value={basis}
            onChange={setBasis}
            options={CHANGE_ORDER_BASES.map((b) => ({
              value: b,
              label: t(`doc.basis.${b}` as TextKey),
            }))}
          />
          <div className="field">
            <label htmlFor="co-reason">{t('doc.reason')}</label>
            <textarea
              id="co-reason"
              className="textarea"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="button-row">
            <button
              type="button"
              className="button primary auto"
              disabled={busy}
              onClick={() => convert('change_order')}
            >
              {t('q.convert')}
            </button>
            <button type="button" className="button ghost" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      <FormError>{error}</FormError>
    </div>
  )
}

// ---- Fertigstellen, Status, Vorschau ------------------------------------------------------------

function DocumentActions({
  doc,
  canWrite,
  canFinalize,
  apply,
  navigate,
}: {
  doc: Doc
  canWrite: boolean
  canFinalize: boolean
  apply: Apply
  navigate: Navigate
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const offer = ['quote', 'cost_estimate', 'change_order'].includes(doc.type)
  const billed = doc.type === 'invoice' || doc.type === 'credit_note'
  const run = async (path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(true)
    setError(null)
    try {
      apply(await apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/${path}`, body ?? {}))
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="doc-actions">
      <a
        className="button ghost"
        href={`/dokumente/${doc.id}/druck`}
        onClick={(e) => {
          e.preventDefault()
          navigate({ view: 'print', id: doc.id })
        }}
      >
        {t('q.preview')}
      </a>
      {canWrite && doc.status === 'draft' && !billed ? (
        <button
          type="button"
          className="button primary auto"
          disabled={busy}
          onClick={() => run('finalize', undefined, t('q.finalizeConfirm'))}
        >
          {t('q.finalize')}
        </button>
      ) : null}
      {canWrite && offer && doc.status === 'finalized' ? (
        <button
          type="button"
          className="button ghost"
          disabled={busy}
          onClick={() => run('status', { status: 'sent' })}
        >
          {t('q.markSent')}
        </button>
      ) : null}
      {canWrite && offer && (doc.status === 'finalized' || doc.status === 'sent') ? (
        <>
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={() => run('status', { status: 'accepted' })}
          >
            {t('q.markAccepted')}
          </button>
          <button
            type="button"
            className="button ghost danger"
            disabled={busy}
            onClick={() => run('status', { status: 'rejected' })}
          >
            {t('q.markRejected')}
          </button>
        </>
      ) : null}
      {canFinalize && billed && doc.status === 'draft' && !finalizing ? (
        <button type="button" className="button primary auto" onClick={() => setFinalizing(true)}>
          {t('inv.finalize')}
        </button>
      ) : null}
      {doc.status === 'draft' && !billed ? <p className="hint">{t('q.finalizeHint')}</p> : null}
      {billed && doc.status === 'draft' && !canFinalize ? (
        <p className="hint">{t('inv.noPermission')}</p>
      ) : null}
      <FormError>{error}</FormError>
      {finalizing ? (
        <FinalizeInvoice
          doc={doc}
          onDone={(result) => {
            setFinalizing(false)
            apply(result)
          }}
          onCancel={() => setFinalizing(false)}
        />
      ) : null}
    </div>
  )
}

/**
 * Festschreiben einer Rechnung (DESIGN.md §7.7): Pflichtangaben-Prüfung, Hinweise bestätigen,
 * künftige Nummer, deutlicher Hinweis auf die Unveränderbarkeit.
 */
function FinalizeInvoice({
  doc,
  onDone,
  onCancel,
}: {
  doc: Doc
  onDone: (result: { data: Doc; etag: string | null }) => void
  onCancel: () => void
}) {
  const [check, setCheck] = useState<FinalizeCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const headingId = useId()
  // Re-check whenever the draft changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: doc.updatedAt triggers a new check
  useEffect(() => {
    setCheck(null)
    api<FinalizeCheck>('GET', `/api/v1/documents/${doc.id}/finalize-check`)
      .then(setCheck)
      .catch((err: ApiError) => setError(err.message))
  }, [doc.id, doc.updatedAt])
  const blocked = !check || check.errors.length > 0
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(
        await apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/finalize`, {
          acknowledgeWarnings: acknowledged,
        }),
      )
    } catch (err) {
      const e = err as ApiError
      setError([e.message, ...Object.values(e.fieldErrors)].join(' '))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="finalize-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('inv.finalizeTitle')}</h2>
      {!check && !error ? <p className="muted">{t('common.loading')}</p> : null}
      {check?.errors.length ? (
        <div role="alert">
          <p>
            <strong>{t('inv.missing')}</strong>
          </p>
          <ul className="issue-list">
            {check.errors.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {check && !check.errors.length ? (
        <>
          <p className="success">{t('inv.complete')}</p>
          {check.warnings.length ? (
            <>
              <ul className="issue-list warning-list">
                {check.warnings.map((issue) => (
                  <li key={issue.message}>{issue.message}</li>
                ))}
              </ul>
              <label className="check-row">
                <input
                  type="checkbox"
                  className="check-box"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>{t('inv.acknowledge')}</span>
              </label>
            </>
          ) : null}
          <p>
            {t('inv.numberPreview')} <strong>{check.numberPreview}</strong>
          </p>
          <p className="notice inline">{t('inv.finalizeWarning')}</p>
        </>
      ) : null}
      <FormError>{error}</FormError>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={busy || blocked || (check.warnings.length > 0 && !acknowledged)}
          onClick={submit}
        >
          {t('inv.finalizeNow')}
        </button>
        <button type="button" className="button ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </section>
  )
}

// ---- Interne Kalkulation (Kosten, Marge, Soll-Stunden) ------------------------------------------

function InternalCalculation({ doc }: { doc: Doc }) {
  const totals = doc.totals
  const percent =
    totals.netCents > 0
      ? ((totals.marginCents / totals.netCents) * 100).toFixed(1).replace('.', ',')
      : null
  return (
    <details className="panel internal">
      <summary>
        <h2 className="summary-title">{t('q.internal')}</h2>
      </summary>
      <dl className="totals">
        <div>
          <dt>{t('q.cost')}</dt>
          <dd>{formatCents(totals.costCents)}</dd>
        </div>
        <div>
          <dt>{t('q.margin')}</dt>
          <dd>
            {formatCents(totals.marginCents)}
            {percent ? ` (${percent} %)` : ''}
          </dd>
        </div>
        <div>
          <dt>{t('q.laborHours')}</dt>
          <dd>{formatQuantity(totals.laborHours)} Std</dd>
        </div>
        {totals.uncalculatedCount ? (
          <div>
            <dt>{t('q.uncalculated')}</dt>
            <dd>{totals.uncalculatedCount}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  )
}

// ---- Kalkulation of a position ------------------------------------------------------------------

type CostLineInput = {
  kind: (typeof COST_KINDS)[number]
  description: string
  quantity: string
  unitId: string
  cost: string
  markup: string
}

function CalculationForm({
  doc,
  item,
  units,
  onDone,
  onCancel,
}: {
  doc: Doc
  item: DocumentItem
  units: UnitSummary[]
  onDone: Apply
  onCancel: () => void
}) {
  const unitOf = (id: string) => units.find((u) => u.id === id)
  const [calcMode, setCalcMode] = useState<'unit_price' | 'total_price'>(
    item.calcMode ?? 'unit_price',
  )
  const [lines, setLines] = useState<CostLineInput[]>(
    item.costLines.length
      ? item.costLines.map((l) => ({
          kind: l.kind,
          description: l.description ?? '',
          quantity: formatInputNumber(l.quantity),
          unitId: l.unit?.id ?? '',
          cost: centsToInput(l.unitCostCents),
          markup: formatInputNumber(l.markupPercent),
        }))
      : [
          {
            kind: 'labor',
            description: '',
            quantity: '',
            unitId: units.find((u) => u.symbol === 'min')?.id ?? '',
            cost: '',
            markup: '',
          },
        ],
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const change = (index: number, patch: Partial<CostLineInput>) =>
    setLines((all) => all.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  const isTime = (unitId: string) => ['min', 'Std'].includes(unitOf(unitId)?.symbol ?? '')

  const save = async (remove = false) => {
    setError(null)
    const body = remove
      ? { calcMode, lines: [] }
      : {
          calcMode,
          lines: lines.map((l, index) => {
            const cents = parseEuro(l.cost)
            if (cents === null || Number.isNaN(cents)) {
              throw new Error(`${t('q.calcCost')} (${index + 1}): ${t('doc.invalidAmount')}`)
            }
            return {
              kind: l.kind,
              description: l.description.trim() || undefined,
              quantity: l.quantity.trim() || '0',
              unitId: l.unitId || null,
              unitCostCents: cents,
              markupPercent: l.markup.trim() || null,
            }
          }),
        }
    setBusy(true)
    try {
      onDone(
        await apiWithEtag<Doc>(
          'POST',
          `/api/v1/documents/${doc.id}/items/${item.id}/calculation`,
          body,
        ),
      )
    } catch (err) {
      setError(
        err instanceof ApiError
          ? [err.message, ...Object.values(err.fieldErrors)].join(' ')
          : String((err as Error).message),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="item-form calc-form">
      <h3>
        {t('q.calcTitle')}: {item.oz} {item.shortText}
      </h3>
      <SelectField
        label={t('q.calcMode')}
        name="calcMode"
        value={calcMode}
        onChange={(v) => setCalcMode(v as 'unit_price' | 'total_price')}
        options={(['unit_price', 'total_price'] as const).map((m) => ({
          value: m,
          label: t(`q.calcMode.${m}` as TextKey),
        }))}
      />
      <ul className="rows">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; order is the identity
          <li key={i} className="row-card">
            <div className="row">
              <SelectField
                label={t('q.calcKind')}
                name={`kind-${i}`}
                value={line.kind}
                onChange={(v) => change(i, { kind: v as CostLineInput['kind'] })}
                options={COST_KINDS.map((k) => ({ value: k, label: t(`q.kind.${k}` as TextKey) }))}
              />
              <div className="field">
                <label htmlFor={`calc-${i}-description`}>{t('q.calcDescription')}</label>
                <input
                  id={`calc-${i}-description`}
                  value={line.description}
                  onChange={(e) => change(i, { description: e.target.value })}
                />
              </div>
            </div>
            <div className="row-with-action">
              <div className="row four">
                <div className="field">
                  <label htmlFor={`calc-${i}-quantity`}>{t('q.calcQuantity')}</label>
                  <input
                    id={`calc-${i}-quantity`}
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => change(i, { quantity: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`calc-${i}-unit`}>{t('q.calcUnit')}</label>
                  <select
                    id={`calc-${i}-unit`}
                    className="select"
                    value={line.unitId}
                    onChange={(e) => change(i, { unitId: e.target.value })}
                  >
                    <option value="">–</option>
                    {units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.symbol}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`calc-${i}-cost`}>
                    {line.kind === 'labor' && isTime(line.unitId)
                      ? t('q.calcRate')
                      : t('q.calcCost')}
                  </label>
                  <input
                    id={`calc-${i}-cost`}
                    inputMode="decimal"
                    value={line.cost}
                    onChange={(e) => change(i, { cost: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`calc-${i}-markup`}>{t('q.calcMarkup')}</label>
                  <input
                    id={`calc-${i}-markup`}
                    inputMode="decimal"
                    placeholder={t('q.calcMarkupDefault')}
                    value={line.markup}
                    onChange={(e) => change(i, { markup: e.target.value })}
                  />
                </div>
              </div>
              <button
                type="button"
                className="button ghost icon danger"
                aria-label={t('d.row.remove')}
                onClick={() => setLines((all) => all.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button ghost small"
        onClick={() =>
          setLines((all) => [
            ...all,
            { kind: 'material', description: '', quantity: '', unitId: '', cost: '', markup: '' },
          ])
        }
      >
        {t('q.calcAddLine')}
      </button>
      {item.calculation ? (
        <p className="muted">
          {tf('q.calcSummary', {
            cost: formatCents(item.calculation.costCents),
            margin: formatCents(item.calculation.marginCents),
            percent: formatQuantity(item.calculation.marginPercent ?? '0'),
            hours: formatQuantity(item.calculation.laborHours),
          })}
        </p>
      ) : null}
      <FormError>{error}</FormError>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={busy}
          onClick={() => save()}
        >
          {t('common.save')}
        </button>
        {item.costLines.length ? (
          <button
            type="button"
            className="button ghost danger"
            disabled={busy}
            onClick={() => save(true)}
          >
            {t('q.calcRemove')}
          </button>
        ) : null}
        <button type="button" className="button ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

// ---- Aus Stammdaten oder Katalog einfügen ---------------------------------------------------------

type PickResult =
  | { source: 'item'; id: string; title: string; detail: string; decimals: number }
  | { source: 'article'; id: string; title: string; detail: string; decimals: number }

function CatalogPicker({
  doc,
  titles,
  apply,
  onClose,
}: {
  doc: Doc
  titles: DocumentItem[]
  apply: Apply
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PickResult[]>([])
  const [quantity, setQuantity] = useState('1')
  const [parentId, setParentId] = useState(titles.at(-1)?.id ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const [services, materials, articles] = await Promise.all([
          api<CatalogItem[]>(
            'GET',
            `/api/v1/catalog/items?kind=service&limit=20&q=${encodeURIComponent(q)}`,
          ),
          api<CatalogItem[]>(
            'GET',
            `/api/v1/catalog/items?kind=material&limit=20&q=${encodeURIComponent(q)}`,
          ),
          api<SupplierArticle[]>(
            'GET',
            `/api/v1/supplier-articles?limit=20&q=${encodeURIComponent(q)}`,
          ),
        ])
        setResults([
          ...[...services, ...materials].map((i) => ({
            source: 'item' as const,
            id: i.id,
            title: i.shortText,
            detail: `${t('c.ownData')} · ${i.kind === 'service' ? t('c.services') : t('c.materials')} · ${formatCents(
              i.priceCents,
            )} / ${i.unit.symbol}`,
            decimals: i.unit.decimals,
          })),
          ...articles.map((a) => ({
            source: 'article' as const,
            id: a.id,
            title: a.shortText,
            detail: `${a.catalogName} ${a.articleNo} · ${articlePrice(a)}`,
            decimals: a.unit?.decimals ?? 2,
          })),
        ])
      } catch (err) {
        setError((err as ApiError).message)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const insert = async (result: PickResult) => {
    setError(null)
    try {
      apply(
        await apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/items/from-catalog`, {
          ...(result.source === 'item'
            ? { catalogItemId: result.id }
            : { supplierArticleId: result.id }),
          quantity: quantity.trim() || '1',
          ...(parentId ? { parentId } : {}),
        }),
      )
      onClose()
    } catch (err) {
      const e = err as ApiError
      setError([e.message, ...Object.values(e.fieldErrors ?? {})].join(' '))
    }
  }

  return (
    <div className="item-form picker">
      <h3>{t('c.insertTitle')}</h3>
      <input
        type="search"
        className="search"
        aria-label={t('c.insertSearch')}
        placeholder={t('c.insertSearch')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="row">
        <div className="field">
          <label htmlFor="pick-quantity">{t('doc.quantity')}</label>
          <input
            id="pick-quantity"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        {titles.length ? (
          <SelectField
            label={t('doc.parent')}
            name="parentId"
            value={parentId}
            onChange={setParentId}
            options={[
              { value: '', label: t('doc.topLevel') },
              ...titles.map((ti) => ({ value: ti.id, label: `${ti.oz} ${ti.shortText ?? ''}` })),
            ]}
          />
        ) : null}
      </div>
      <FormError>{error}</FormError>
      {results.length ? (
        <ul className="list">
          {results.map((r) => (
            <li key={`${r.source}-${r.id}`} className="list-row">
              <span>
                <strong>{r.title}</strong>
                <span className="muted block">{r.detail}</span>
              </span>
              <span className="actions">
                <button
                  type="button"
                  className="button ghost small"
                  aria-label={`${t('c.insertAction')}: ${r.title}`}
                  onClick={() => insert(r)}
                >
                  {t('c.insertAction')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="button-row">
        <button type="button" className="button ghost" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}
