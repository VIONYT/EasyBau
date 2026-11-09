import type {
  DocumentDetail,
  DocumentOption,
  DocumentSummary,
  Me,
  ProjectDetail,
} from '@opc/schemas'
import { CHANGE_ORDER_BASES } from '@opc/schemas/constants'
import { useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatCents, formatDateTime } from '../format'
import { FormError, optional, SelectField, TextArea, useForm } from '../forms'
import { type TextKey, t } from '../i18n'
import type { Navigate } from '../router'

/** „Angebot“, „2. Abschlagsrechnung“, „Nachtragsangebot N01“ … */
export function documentLabel(
  doc: Pick<DocumentSummary, 'type' | 'invoiceKind' | 'progressNo'> & {
    changeOrder: { number: number } | null
  },
): string {
  if (doc.type === 'invoice' && doc.invoiceKind) {
    const label = t(`doc.invoice.${doc.invoiceKind}` as TextKey)
    return doc.invoiceKind === 'progress' && doc.progressNo ? `${doc.progressNo}. ${label}` : label
  }
  const label = t(`doc.type.${doc.type}` as TextKey)
  return doc.changeOrder ? `${label} N${String(doc.changeOrder.number).padStart(2, '0')}` : label
}

const GROUPS: { key: TextKey; types: DocumentSummary['type'][] }[] = [
  { key: 'documents.group.offers', types: ['quote', 'cost_estimate'] },
  { key: 'documents.group.orders', types: ['order_confirmation'] },
  { key: 'documents.group.changeOrders', types: ['change_order'] },
  { key: 'documents.group.deliveries', types: ['delivery_note'] },
  { key: 'documents.group.invoices', types: ['invoice'] },
  { key: 'documents.group.credits', types: ['credit_note'] },
]

export function StatusChip({ status }: { status: DocumentSummary['status'] }) {
  return <span className={`chip chip--${status}`}>{t(`doc.status.${status}` as TextKey)}</span>
}

/** Documents of a project, grouped by type, and „Neues Dokument“. */
export function ProjectDocuments({
  me,
  project,
  navigate,
}: {
  me: Me
  project: ProjectDetail
  navigate: Navigate
}) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const canWrite = me.permissions.includes('document.write') && !project.archived

  useEffect(() => {
    api<DocumentSummary[]>('GET', `/api/v1/projects/${project.id}/documents`)
      .then(setDocuments)
      .catch((err: ApiError) => setError(err.message))
  }, [project.id])

  const open = (id: string) => navigate({ view: 'document', id })

  return (
    <div>
      <div className="section-head">
        <h2>{t('documents.title')}</h2>
        {canWrite && !creating ? (
          <button type="button" className="button primary auto" onClick={() => setCreating(true)}>
            {t('documents.new')}
          </button>
        ) : null}
      </div>
      {creating && documents ? (
        <NewDocument
          projectId={project.id}
          documents={documents}
          onCancel={() => setCreating(false)}
          onCreated={(doc) => open(doc.id)}
        />
      ) : null}
      <FormError>{error}</FormError>
      {!documents ? <p className="muted">{t('common.loading')}</p> : null}
      {documents && !documents.length ? <p className="muted">{t('documents.empty')}</p> : null}
      {GROUPS.map((group) => {
        const docs = documents?.filter((d) => group.types.includes(d.type)) ?? []
        if (!docs.length) return null
        return (
          <div key={group.key} className="doc-group">
            <h3>{t(group.key)}</h3>
            <ul className="list">
              {docs.map((d) => (
                <li
                  key={d.id}
                  className={`list-link${d.status === 'cancelled' ? ' is-cancelled' : ''}`}
                >
                  <a
                    href={`/dokumente/${d.id}`}
                    onClick={(e) => {
                      e.preventDefault()
                      open(d.id)
                    }}
                  >
                    <span className="doc-line">
                      <strong>{documentLabel(d)}</strong>
                      <span className="amount">{formatCents(d.netTotalCents)}</span>
                    </span>
                    <span className="muted">
                      {d.status === 'cancelled' && d.number ? (
                        <>
                          <s className="locked-number">{d.number}</s>{' '}
                        </>
                      ) : null}
                      {[
                        d.status === 'cancelled'
                          ? null
                          : (d.number ?? t('documents.draftNoNumber')),
                        d.cancelledBy
                          ? t('doc.cancelledBy').replace('{number}', d.cancelledBy.number)
                          : null,
                        d.cancels?.number
                          ? t('doc.cancels').replace('{number}', d.cancels.number)
                          : null,
                        d.subject,
                        formatDateTime(d.documentDate, 'date'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span>
                      <StatusChip status={d.status} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

const optionKey = (o: Pick<DocumentOption, 'type' | 'invoiceKind'>) =>
  o.invoiceKind ? `${o.type}:${o.invoiceKind}` : o.type

function NewDocument({
  projectId,
  documents,
  onCancel,
  onCreated,
}: {
  projectId: string
  documents: DocumentSummary[]
  onCancel: () => void
  onCreated: (doc: DocumentDetail) => void
}) {
  const [options, setOptions] = useState<DocumentOption[] | null>(null)
  const [selected, setSelected] = useState('quote')
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    api<DocumentOption[]>('GET', `/api/v1/projects/${projectId}/document-options`)
      .then(setOptions)
      .catch((err: ApiError) => setLoadError(err.message))
  }, [projectId])

  const choice = options?.find((o) => optionKey(o) === selected)
  const form = useForm(
    (data) =>
      api<DocumentDetail>('POST', `/api/v1/projects/${projectId}/documents`, {
        type: choice?.type,
        invoiceKind: choice?.invoiceKind ?? undefined,
        sourceDocumentId: optional(data, 'sourceDocumentId'),
        basis: choice?.type === 'change_order' ? optional(data, 'basis') : undefined,
        reason: choice?.type === 'change_order' ? optional(data, 'reason') : undefined,
      }),
    onCreated,
  )

  return (
    <form className="panel" onSubmit={form.onSubmit} noValidate>
      <h2>{t('documents.new')}</h2>
      <FormError>{loadError ?? form.error}</FormError>
      {!options ? <p className="muted">{t('common.loading')}</p> : null}
      {options ? (
        <fieldset className="choices">
          <legend>{t('documents.chooseType')}</legend>
          {options.map((o) => {
            const key = optionKey(o)
            return (
              <label key={key} className={o.available ? undefined : 'disabled'}>
                <input
                  type="radio"
                  name="documentType"
                  value={key}
                  checked={selected === key}
                  disabled={!o.available}
                  onChange={() => setSelected(key)}
                />
                <span>
                  {documentLabel({
                    type: o.type,
                    invoiceKind: o.invoiceKind,
                    progressNo: o.progressNo,
                    changeOrder: null,
                  })}
                  {o.reason ? <span className="hint"> – {o.reason}</span> : null}
                </span>
              </label>
            )
          })}
        </fieldset>
      ) : null}
      {choice?.type === 'change_order' ? (
        <>
          <SelectField
            label={t('doc.basis')}
            name="basis"
            defaultValue="additional_work"
            options={CHANGE_ORDER_BASES.map((b) => ({
              value: b,
              label: t(`doc.basis.${b}` as TextKey),
            }))}
          />
          <TextArea label={t('doc.reason')} name="reason" />
        </>
      ) : null}
      {documents.length ? (
        <SelectField
          label={t('documents.source')}
          name="sourceDocumentId"
          defaultValue=""
          options={[
            { value: '', label: t('documents.sourceNone') },
            ...documents.map((d) => ({
              value: d.id,
              label: `${documentLabel(d)} · ${d.number ?? t('doc.status.draft')} · ${formatCents(d.netTotalCents)}`,
            })),
          ]}
        />
      ) : null}
      <div className="button-row">
        <button
          type="submit"
          className="button primary auto"
          disabled={form.busy || !choice?.available}
        >
          {t('documents.create')}
        </button>
        <button type="button" className="button ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}
