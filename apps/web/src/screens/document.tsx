import type {
  CancelInvoiceResult,
  CatalogItem,
  ContactDetail,
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
} from '@easybau/schemas'
import {
  CHANGE_ORDER_BASES,
  COST_KINDS,
  PRICED_POSITION_TYPES,
  TAX_MODES,
} from '@easybau/schemas/constants'
import { Button, buttonClass } from '@easybau/ui'
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react'
import { ApiError, api, apiWithEtag } from '../api'
import {
  centsToInput,
  formatCents,
  formatDateTime,
  formatInputNumber,
  formatQuantity,
  formatUnitAmount,
  parseEuro,
} from '../format'
import { Field, FormError, optional, SelectField, TextArea, useForm, value } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import type { Navigate } from '../router'
import { articlePrice } from './catalog'
import { DocumentEmailPanel } from './document-email'
import { documentLabel, StatusChip } from './documents'
import { DunningPanel } from './dunning'
import { EvidencePanel } from './evidence'
import {
  ImageCaptionForm,
  ImagePositionForm,
  ImagePositionView,
  SaveToCatalogButton,
  TARGET_PRICE_TYPES,
  TargetPricePanel,
  VersionsPanel,
} from './offer-tools'
import { ReceivablePanel } from './payments'
import { ReportApplyPanel } from './report-apply'

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
      {doc.purgedAt ? (
        <p className="notice inline" role="status">
          {t('doc.purged')}
        </p>
      ) : doc.status !== 'draft' && !doc.cancelledBy ? (
        <p className="notice inline" role="status">
          {t('doc.locked')}
        </p>
      ) : null}
      <FormError>{error}</FormError>

      {doc.type === 'quote' || doc.type === 'change_order' ? (
        <ChangeOrderSwitch doc={doc} editable={editable} apply={apply} />
      ) : null}
      {doc.changeOrderInfo?.priceReview.length ? (
        <p className="notice inline warning" role="note">
          {tf('co.priceReview', {
            list: doc.changeOrderInfo.priceReview
              .map((p) => `${[p.oz, p.shortText].filter(Boolean).join(' ')} (${p.percent} %)`)
              .join(', '),
          })}
        </p>
      ) : null}
      {doc.type === 'change_order' && doc.changeOrderInfo ? (
        <EvidencePanel
          doc={doc}
          canWrite={me.permissions.includes('document.write')}
          apply={apply}
          navigate={navigate}
        />
      ) : null}
      <VersionsPanel
        doc={doc}
        canWrite={me.permissions.includes('document.write')}
        navigate={navigate}
      />
      <DocumentActions
        doc={doc}
        canWrite={me.permissions.includes('document.write')}
        canFinalize={me.permissions.includes('document.finalize')}
        canCancel={me.permissions.includes('document.cancel')}
        apply={apply}
        navigate={navigate}
      />
      {doc.finalizedAt && !doc.purgedAt ? (
        <DocumentEmailPanel
          doc={doc}
          canWrite={me.permissions.includes('document.write')}
          onSent={() =>
            apiWithEtag<Doc>('GET', `/api/v1/documents/${id}`)
              .then(apply)
              .catch((err: ApiError) => setError(err.message))
          }
        />
      ) : null}
      {doc.receivable ? (
        <ReceivablePanel
          doc={doc}
          canWrite={me.permissions.includes('payment.write')}
          onChange={(receivable) => setDoc({ ...doc, receivable })}
        />
      ) : null}
      {doc.receivable && doc.type === 'invoice' && doc.invoiceKind !== 'cancellation' ? (
        <DunningPanel
          doc={doc}
          canWrite={me.permissions.includes('dunning.write')}
          onIssued={() =>
            apiWithEtag<Doc>('GET', `/api/v1/documents/${id}`)
              .then(apply)
              .catch((err: ApiError) => setError(err.message))
          }
        />
      ) : null}

      <HeaderForm doc={doc} etag={etag} editable={editable} apply={apply} />
      <Positions
        doc={doc}
        editable={editable}
        units={units}
        rates={rates}
        apply={apply}
        canUseCatalog={me.permissions.includes('catalog.read')}
        canSaveCatalog={me.permissions.includes('catalog.write')}
      />
      <Totals doc={doc} />
      {editable &&
      TARGET_PRICE_TYPES.includes(doc.type) &&
      me.permissions.includes('price.view') ? (
        <TargetPricePanel doc={doc} apply={apply} />
      ) : null}
      {me.permissions.includes('price.view') ? <InternalCalculation doc={doc} /> : null}

      {editable ? (
        <Button type="button" variant="ghost" width="natural" danger onClick={remove}>
          {t('doc.deleteDraft')}
        </Button>
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
  // Ansprechpartner („z. Hd.“): persons linked to the chosen recipient organization.
  const [recipientId, setRecipientId] = useState(doc.contact?.id ?? '')
  const [persons, setPersons] = useState<{ id: string; displayName: string }[]>([])
  // Anschriften of the recipient (main, billing, delivery, other) for „Anschrift“.
  const [addresses, setAddresses] = useState<ContactDetail['addresses']>([])
  useEffect(() => {
    if (!editable || !recipientId) {
      setPersons([])
      setAddresses([])
      return
    }
    api<ContactDetail>('GET', `/api/v1/contacts/${recipientId}`)
      .then((c) => {
        setPersons(
          c.links
            .filter((l) => l.kind === 'person')
            .map((l) => ({ id: l.contactId, displayName: l.displayName })),
        )
        setAddresses(c.addresses)
      })
      .catch(() => {
        setPersons([])
        setAddresses([])
      })
  }, [editable, recipientId])
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
          contactPersonId: value(data, 'contactPersonId') || null,
          ...(data.has('recipientAddressId')
            ? { recipientAddressId: value(data, 'recipientAddressId') || null }
            : {}),
          // Another recipient: the server applies the default of the settings (§ 35a matrix).
          ...(doc.type !== 'delivery_note' &&
          (value(data, 'contactId') || null) === (doc.contact?.id ?? null)
            ? { showLaborShare: data.get('showLaborShare') === 'on' }
            : {}),
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
            onChange={setRecipientId}
            error={form.fieldErrors.contactId}
          />
          {persons.length || doc.contactPerson ? (
            <SelectField
              key={recipientId}
              label={t('doc.contactPerson')}
              name="contactPersonId"
              defaultValue={
                recipientId === (doc.contact?.id ?? '') ? (doc.contactPerson?.id ?? '') : ''
              }
              options={[
                { value: '', label: t('common.none') },
                ...(doc.contactPerson &&
                recipientId === (doc.contact?.id ?? '') &&
                !persons.some((p) => p.id === doc.contactPerson?.id)
                  ? [{ value: doc.contactPerson.id, label: doc.contactPerson.displayName }]
                  : []),
                ...persons.map((p) => ({ value: p.id, label: p.displayName })),
              ]}
              error={form.fieldErrors.contactPersonId}
            />
          ) : null}
          {addresses.length > 1 ? (
            <SelectField
              key={`address-${recipientId}`}
              label={t('doc.recipientAddress')}
              name="recipientAddressId"
              defaultValue={
                recipientId === (doc.contact?.id ?? '') ? (doc.recipientAddressId ?? '') : ''
              }
              options={[
                { value: '', label: t('doc.recipientAddress.auto') },
                ...addresses.map((a) => ({
                  value: a.id,
                  label: `${t(`doc.addressKind.${a.kind}` as TextKey)}: ${[
                    a.recipientBlock?.split('\n')[0],
                    a.street,
                    [a.postalCode, a.city].filter(Boolean).join(' '),
                  ]
                    .filter(Boolean)
                    .join(', ')}`,
                })),
              ]}
              error={form.fieldErrors.recipientAddressId}
            />
          ) : null}
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
          {doc.type !== 'delivery_note' ? (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  name="showLaborShare"
                  defaultChecked={doc.showLaborShare}
                  key={String(doc.showLaborShare)}
                />
                {t('doc.laborShare')}
              </label>
              {doc.showLaborShare ? (
                <p className="hint">
                  {doc.totals.laborShare.grossCents
                    ? `${t('doc.laborShareAmount')}: ${formatCents(doc.totals.laborShare.grossCents)}`
                    : t('doc.laborShareNone')}
                </p>
              ) : null}
            </>
          ) : null}
          {editable ? (
            <div className="button-row">
              <Button type="submit" variant="primary" disabled={form.busy}>
                {t('common.save')}
              </Button>
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
  canSaveCatalog,
}: {
  doc: Doc
  editable: boolean
  units: UnitSummary[]
  rates: TaxRateSummary[]
  apply: Apply
  canUseCatalog: boolean
  canSaveCatalog: boolean
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
              ) : editingId === item.id && item.positionType === 'image' ? (
                <ImageCaptionForm
                  doc={doc}
                  item={item}
                  onDone={(result) => {
                    apply(result)
                    setEditingId(null)
                  }}
                  onCancel={() => setEditingId(null)}
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
                  {canSaveCatalog && isPriced(item.positionType) && doc.type !== 'invoice' ? (
                    <SaveToCatalogButton doc={doc} item={item} />
                  ) : null}
                  {editable ? (
                    <span className="actions">
                      {isPriced(item.positionType) ? (
                        <Button
                          type="button"
                          variant="ghost"
                          width="natural"
                          size="small"
                          aria-label={`${t('q.calc')}: ${item.shortText ?? ''}`}
                          onClick={() => setCalcId(item.id)}
                        >
                          {t('q.calc')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        width="natural"
                        size="icon"
                        aria-label={`${t('common.edit')}: ${item.shortText ?? t('doc.pos.text')}`}
                        onClick={() => setEditingId(item.id)}
                      >
                        ✎
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        width="natural"
                        size="icon"
                        aria-label={t('common.up')}
                        onClick={() => move(item, 'up')}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        width="natural"
                        size="icon"
                        aria-label={t('common.down')}
                        onClick={() => move(item, 'down')}
                      >
                        ↓
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        width="natural"
                        size="icon"
                        danger
                        aria-label={t('common.delete')}
                        onClick={() => remove(item)}
                      >
                        ✕
                      </Button>
                    </span>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {editable && adding === 'image' ? (
        <ImagePositionForm
          doc={doc}
          onDone={(result) => {
            apply(result)
            setAdding(null)
          }}
          onCancel={() => setAdding(null)}
        />
      ) : null}
      {editable && adding && adding !== 'image' ? (
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
        <Button
          type="button"
          variant="ghost"
          width="natural"
          size="small"
          className="apply-measurements"
          onClick={() =>
            run(() => apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/apply-measurements`))
          }
        >
          {t('doc.applyMeasurements')}
        </Button>
      ) : null}
      {editable && !adding && doc.type === 'invoice' && doc.invoiceKind !== 'cancellation' ? (
        <ReportApplyPanel doc={doc} apply={apply} />
      ) : null}
      {editable && picking ? (
        <CatalogPicker doc={doc} titles={titles} apply={apply} onClose={() => setPicking(false)} />
      ) : null}
      {editable && !adding && !picking && canUseCatalog ? (
        <Button
          type="button"
          variant="ghost"
          width="natural"
          size="small"
          onClick={() => setPicking(true)}
        >
          {t('c.insert')}
        </Button>
      ) : null}
      {editable && !adding ? (
        <fieldset className="add-bar">
          <legend className="muted">{t('doc.addPosition')}</legend>
          {(['title', 'item', 'lump_sum', 'optional', 'alternative', 'text', 'image'] as const).map(
            (type) => (
              <Button
                key={type}
                type="button"
                variant="ghost"
                width="natural"
                size="small"
                onClick={() => setAdding(type)}
              >
                + {t(`doc.pos.${type}` as TextKey)}
              </Button>
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
  if (item.positionType === 'image') return <ImagePositionView item={item} />
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
                ? `${t('inv.measured')} ${formatUnitAmount(item.cumulativeQuantity, item.unit?.decimals)} ${item.unit?.symbol ?? ''}`
                : null,
              item.previouslyBilledQuantity !== null
                ? `${t('inv.billedBefore')} ${formatUnitAmount(item.previouslyBilledQuantity, item.unit?.decimals)} ${item.unit?.symbol ?? ''}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : null}
        <span className="muted block calc">
          {formatUnitAmount(item.quantity, item.unit?.decimals)} {item.unit?.symbol} ×{' '}
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
        <Button type="submit" variant="primary" disabled={busy}>
          {item ? t('common.save') : t('common.add')}
        </Button>
        <Button type="button" variant="ghost" width="natural" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
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
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => convert('change_order')}
            >
              {t('q.convert')}
            </Button>
            <Button type="button" variant="ghost" width="natural" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </Button>
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
  canCancel,
  apply,
  navigate,
}: {
  doc: Doc
  canWrite: boolean
  canFinalize: boolean
  canCancel: boolean
  apply: Apply
  navigate: Navigate
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [cancelling, setCancelling] = useState<'cancel' | 'correct' | null>(null)
  const [partial, setPartial] = useState<string[] | null>(null)
  const cancellable =
    canCancel &&
    doc.type === 'invoice' &&
    doc.invoiceKind !== 'cancellation' &&
    (doc.status === 'finalized' || doc.status === 'sent')
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
      {doc.purgedAt ? null : (
        <>
          <a
            className={buttonClass({ variant: 'ghost', width: 'natural' })}
            href={`/dokumente/${doc.id}/druck`}
            onClick={(e) => {
              e.preventDefault()
              navigate({ view: 'print', id: doc.id })
            }}
          >
            {t('q.preview')}
          </a>
          <a
            className={buttonClass({ variant: 'ghost', width: 'natural' })}
            href={`/api/v1/documents/${doc.id}/pdf`}
            target="_blank"
            rel="noopener"
          >
            {t('doc.pdf')}
          </a>
        </>
      )}
      {(doc.purgedAt ? [] : (doc.einvoice?.files ?? [])).map((file) => (
        <a
          key={file.format}
          className={buttonClass({ variant: 'ghost', width: 'natural' })}
          href={`/api/v1/documents/${doc.id}/einvoice/${file.format}`}
          download
        >
          {t(`einv.download.${file.format}` as TextKey)}
        </a>
      ))}
      {canWrite && doc.status === 'draft' && !billed ? (
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          onClick={() => run('finalize', undefined, t('q.finalizeConfirm'))}
        >
          {t('q.finalize')}
        </Button>
      ) : null}
      {canWrite && offer && doc.status === 'finalized' ? (
        <Button
          type="button"
          variant="ghost"
          width="natural"
          disabled={busy}
          onClick={() => run('status', { status: 'sent' })}
        >
          {t('q.markSent')}
        </Button>
      ) : null}
      {canWrite && offer && (doc.status === 'finalized' || doc.status === 'sent') ? (
        <>
          <Button
            type="button"
            variant="ghost"
            width="natural"
            disabled={busy}
            onClick={() => run('status', { status: 'accepted' })}
          >
            {t('q.markAccepted')}
          </Button>
          {doc.type === 'change_order' && partial === null ? (
            <Button
              type="button"
              variant="ghost"
              width="natural"
              disabled={busy}
              onClick={() => setPartial([])}
            >
              {t('q.markPartial')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            width="natural"
            danger
            disabled={busy}
            onClick={() => run('status', { status: 'rejected' })}
          >
            {t('q.markRejected')}
          </Button>
        </>
      ) : null}
      {partial !== null ? (
        <fieldset className="panel partial-acceptance">
          <legend>{t('q.partialTitle')}</legend>
          <p className="hint">{t('q.partialHint')}</p>
          {doc.items
            .filter((i) => i.positionType === 'item' || i.positionType === 'lump_sum')
            .map((i) => (
              <label key={i.id} className="check">
                <input
                  type="checkbox"
                  checked={partial.includes(i.id)}
                  onChange={(e) =>
                    setPartial(
                      e.target.checked ? [...partial, i.id] : partial.filter((x) => x !== i.id),
                    )
                  }
                />
                <span>
                  {[i.oz, i.shortText].filter(Boolean).join(' ')}
                  {i.totalCents !== null ? ` · ${formatCents(i.totalCents)}` : ''}
                </span>
              </label>
            ))}
          <div className="button-row">
            <Button
              type="button"
              variant="primary"
              disabled={busy || partial.length === 0}
              onClick={async () => {
                await run('status', { status: 'partially_accepted', acceptedItemIds: partial })
                setPartial(null)
              }}
            >
              {t('q.partialConfirm')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPartial(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </fieldset>
      ) : null}
      {doc.status === 'partially_accepted' && doc.changeOrderInfo?.acceptedItemIds ? (
        <p className="hint" role="status">
          {tf('q.partialSummary', {
            list: doc.items
              .filter((i) => doc.changeOrderInfo?.acceptedItemIds?.includes(i.id))
              .map((i) => [i.oz, i.shortText].filter(Boolean).join(' '))
              .join(', '),
          })}
        </p>
      ) : null}
      {canFinalize && billed && doc.status === 'draft' && !finalizing ? (
        <Button type="button" variant="primary" onClick={() => setFinalizing(true)}>
          {t('inv.finalize')}
        </Button>
      ) : null}
      {cancellable && !cancelling ? (
        <>
          <Button
            type="button"
            variant="ghost"
            width="natural"
            onClick={() => setCancelling('correct')}
          >
            {t('inv.correct')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            width="natural"
            danger
            onClick={() => setCancelling('cancel')}
          >
            {t('inv.cancel')}
          </Button>
        </>
      ) : null}
      {doc.einvoice?.files.length ? (
        <p className="hint einvoice-status" role="status">
          <span>
            {tf('einv.validated', {
              formats: doc.einvoice.files
                .map((f) => t(`einv.format.${f.format}` as TextKey))
                .join(', '),
              date: formatDateTime(doc.einvoice.files[0]?.validatedAt ?? ''),
            })}
          </span>
          <a href={`/api/v1/documents/${doc.id}/einvoice/zugferd/report`} download>
            {t('einv.report')}
          </a>
        </p>
      ) : null}
      {doc.archive?.enabled ? (
        <p className="hint archive-status" role="status">
          {doc.archive.archivedAt
            ? tf('arch.archived', { date: formatDateTime(doc.archive.retainUntil ?? '', 'date') })
            : t('arch.pending')}
        </p>
      ) : null}
      {doc.status === 'draft' && !billed ? <p className="hint">{t('q.finalizeHint')}</p> : null}
      {billed && doc.status === 'draft' && !canFinalize ? (
        <p className="hint">{t('inv.noPermission')}</p>
      ) : null}
      <FormError>{error}</FormError>
      {cancelling ? (
        <CancelInvoice
          doc={doc}
          reissue={cancelling === 'correct'}
          onDone={async (result) => {
            setCancelling(null)
            if (result.reissue) {
              navigate({ view: 'document', id: result.reissue.id })
            } else {
              apply(await apiWithEtag<Doc>('GET', `/api/v1/documents/${doc.id}`))
            }
          }}
          onCancel={() => setCancelling(null)}
        />
      ) : null}
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
 * Storno (DESIGN.md §4.1, §7.6): Stornorechnung with its own number; „Rechnung korrigieren“
 * creates the new draft in the same step and explains what happens.
 */
function CancelInvoice({
  doc,
  reissue,
  onDone,
  onCancel,
}: {
  doc: Doc
  reissue: boolean
  onDone: (result: CancelInvoiceResult) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headingId = useId()
  const reasonId = useId()
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(
        await api<CancelInvoiceResult>('POST', `/api/v1/documents/${doc.id}/cancel`, {
          reason,
          reissue,
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
      <h2 id={headingId}>{reissue ? t('inv.correctTitle') : t('inv.cancelTitle')}</h2>
      <p>{tf('inv.cancelExplain', { number: doc.number ?? '' })}</p>
      {reissue ? <p>{t('inv.correctExplain')}</p> : null}
      <div className="field">
        <label htmlFor={reasonId}>{t('inv.cancelReason')}</label>
        <textarea
          id={reasonId}
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <FormError>{error}</FormError>
      <div className="button-row">
        <Button
          type="button"
          variant={reissue ? 'primary' : 'destructive'}
          disabled={busy || reason.trim().length < 3}
          onClick={submit}
        >
          {reissue ? t('inv.correctNow') : t('inv.cancelNow')}
        </Button>
        <Button type="button" variant="ghost" width="natural" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </section>
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
          <p className="hint">{t('inv.einvoiceHint')}</p>
          <p className="notice inline">{t('inv.finalizeWarning')}</p>
        </>
      ) : null}
      <FormError>{error}</FormError>
      <div className="button-row">
        <Button
          type="button"
          variant="primary"
          disabled={busy || blocked || (check.warnings.length > 0 && !acknowledged)}
          onClick={submit}
        >
          {t('inv.finalizeNow')}
        </Button>
        <Button type="button" variant="ghost" width="natural" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </section>
  )
}

// ---- Interne Kalkulation (Kosten, Marge, Soll-Stunden) ------------------------------------------

function InternalCalculation({ doc }: { doc: Doc }) {
  const totals = doc.totals
  // The server leaves costs out for roles without price.view.
  if (totals.costCents === null || totals.marginCents === null) return null
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
  /** Lohngruppe of a labor line (kept when saved again, e.g. from Regieberichte). */
  wageGroupId?: string | null
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
          wageGroupId: l.wageGroupId,
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
              wageGroupId: l.kind === 'labor' ? (l.wageGroupId ?? null) : null,
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
              <Button
                type="button"
                variant="ghost"
                width="natural"
                size="icon"
                danger
                aria-label={t('d.row.remove')}
                onClick={() => setLines((all) => all.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="ghost"
        width="natural"
        size="small"
        onClick={() =>
          setLines((all) => [
            ...all,
            { kind: 'material', description: '', quantity: '', unitId: '', cost: '', markup: '' },
          ])
        }
      >
        {t('q.calcAddLine')}
      </Button>
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
        <Button type="button" variant="primary" disabled={busy} onClick={() => save()}>
          {t('common.save')}
        </Button>
        {item.costLines.length ? (
          <Button
            type="button"
            variant="ghost"
            width="natural"
            danger
            disabled={busy}
            onClick={() => save(true)}
          >
            {t('q.calcRemove')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" width="natural" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
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
                <Button
                  type="button"
                  variant="ghost"
                  width="natural"
                  size="small"
                  aria-label={`${t('c.insertAction')}: ${r.title}`}
                  onClick={() => insert(r)}
                >
                  {t('c.insertAction')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="button-row">
        <Button type="button" variant="ghost" width="natural" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
