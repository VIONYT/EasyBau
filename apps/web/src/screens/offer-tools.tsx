import type {
  CatalogItem,
  DocumentDetail,
  DocumentItem,
  FileSummary,
  TargetPriceResult,
} from '@opc/schemas'
import { useEffect, useId, useState } from 'react'
import { type ApiError, api, apiWithEtag, uploadFile } from '../api'
import { formatCents, parseEuro } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import type { Navigate } from '../router'

/** Angebot (P2.12): Zielpreis, Versionen, Bild-Positionen, „In Stammdaten speichern“. */

type Doc = DocumentDetail
type Apply = (result: { data: Doc; etag: string | null }) => void

export const TARGET_PRICE_TYPES = ['quote', 'cost_estimate', 'order_confirmation', 'change_order']
const VERSIONED_TYPES = ['quote', 'cost_estimate']

/** „Preis anpassen“: reach a desired net total by scaling the markups of calculated positions. */
export function TargetPricePanel({ doc, apply }: { doc: Doc; apply: Apply }) {
  const id = useId()
  const [target, setTarget] = useState('')
  const [result, setResult] = useState<TargetPriceResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (applyIt: boolean) => {
    const cents = parseEuro(target)
    if (cents === null) {
      setError(t('tp.invalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api<TargetPriceResult>('POST', `/api/v1/documents/${doc.id}/target-price`, {
        targetNetCents: cents,
        apply: applyIt,
      })
      setResult(res)
      // Reload with a fresh ETag for later edits of the header.
      if (res.document) apply(await apiWithEtag<Doc>('GET', `/api/v1/documents/${doc.id}`))
    } catch (err) {
      setError((err as ApiError).message)
      setResult(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="panel">
      <summary>
        <h2 className="summary-title">{t('tp.title')}</h2>
      </summary>
      <p className="hint">{t('tp.hint')}</p>
      <div className="field">
        <label htmlFor={id}>{t('tp.target')}</label>
        <input
          id={id}
          inputMode="decimal"
          value={target}
          placeholder={formatCents(doc.totals.netCents)}
          onChange={(e) => {
            setTarget(e.target.value)
            setResult(null)
          }}
        />
      </div>
      <FormError>{error}</FormError>
      {result ? (
        <div className="target-result" role="status">
          <p>
            {tf(result.applied ? 'tp.applied' : 'tp.preview', {
              before: formatCents(result.currentNetCents),
              after: formatCents(result.netCents),
              adjusted: String(result.adjustedCount),
              fixed: String(result.fixedCount),
            })}
          </p>
          {result.residualCents !== 0 ? (
            <p className="hint">
              {tf('tp.residual', { amount: formatCents(result.residualCents) })}
            </p>
          ) : null}
          {result.belowCost.length ? (
            <p className="warning">
              {tf('tp.belowCost', {
                list: result.belowCost
                  .map((b) => `${b.oz ?? ''} ${b.shortText ?? ''}`.trim())
                  .join(', '),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="button-row">
        <button
          type="button"
          className="button ghost auto"
          disabled={busy || !target}
          onClick={() => void run(false)}
        >
          {t('tp.previewButton')}
        </button>
        <button
          type="button"
          className="button primary auto"
          disabled={busy || !result || result.applied}
          onClick={() => void run(true)}
        >
          {t('tp.apply')}
        </button>
      </div>
    </details>
  )
}

/** Angebotsversionen: list and „Neue Version“ for a finished quote. */
export function VersionsPanel({
  doc,
  canWrite,
  navigate,
}: {
  doc: Doc
  canWrite: boolean
  navigate: Navigate
}) {
  const [error, setError] = useState<string | null>(null)
  if (!VERSIONED_TYPES.includes(doc.type)) return null
  const newest = doc.versions.length ? doc.versions[doc.versions.length - 1] : null
  const canCreate =
    canWrite &&
    doc.status !== 'draft' &&
    doc.status !== 'cancelled' &&
    (!newest || newest.id === doc.id)
  if (!doc.versions.length && !canCreate) return null
  return (
    <section className="panel" aria-labelledby="versions-title">
      <h2 id="versions-title">{t('ver.title')}</h2>
      {doc.versions.length ? (
        <ol className="list">
          {doc.versions.map((v) => (
            <li key={v.id} className="list-row">
              {v.id === doc.id ? (
                <strong>
                  {tf('ver.label', { n: String(v.version) })} · {v.number ?? t('ver.draft')}
                </strong>
              ) : (
                <a
                  href={`/dokumente/${v.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate({ view: 'document', id: v.id })
                  }}
                >
                  {tf('ver.label', { n: String(v.version) })} · {v.number ?? t('ver.draft')}
                </a>
              )}
              <span className="muted">{t(`doc.status.${v.status}` as TextKey)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {newest && newest.id !== doc.id ? <p className="hint">{t('ver.outdated')}</p> : null}
      <FormError>{error}</FormError>
      {canCreate ? (
        <button
          type="button"
          className="button ghost auto"
          onClick={async () => {
            setError(null)
            try {
              const created = await api<Doc>('POST', `/api/v1/documents/${doc.id}/versions`, {})
              navigate({ view: 'document', id: created.id })
            } catch (err) {
              setError((err as ApiError).message)
            }
          }}
        >
          {t('ver.create')}
        </button>
      ) : null}
    </section>
  )
}

const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** New Bild-Position: an image of the project's Ablage or a new upload. */
export function ImagePositionForm({
  doc,
  onDone,
  onCancel,
}: {
  doc: Doc
  onDone: Apply
  onCancel: () => void
}) {
  const [files, setFiles] = useState<FileSummary[] | null>(null)
  const [fileId, setFileId] = useState('')
  const [caption, setCaption] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selectId = useId()
  const captionId = useId()
  const uploadId = useId()
  useEffect(() => {
    api<FileSummary[]>('GET', `/api/v1/projects/${doc.project.id}/files`)
      .then((list) => setFiles(list.filter((f) => IMAGE_MIME.includes(f.mimeType))))
      .catch((err: ApiError) => setError(err.message))
  }, [doc.project.id])
  const upload = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const created = await uploadFile<FileSummary>(
        `/api/v1/projects/${doc.project.id}/files?filename=${encodeURIComponent(file.name)}`,
        file,
      )
      setFiles((list) => [created, ...(list ?? [])])
      setFileId(created.id)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(
        await apiWithEtag<Doc>('POST', `/api/v1/documents/${doc.id}/items`, {
          positionType: 'image',
          imageFileId: fileId,
          shortText: caption.trim() || null,
        }),
      )
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="item-form panel">
      <h3>{t('img.title')}</h3>
      <div className="field">
        <label htmlFor={selectId}>{t('img.file')}</label>
        <select
          id={selectId}
          className="select"
          value={fileId}
          onChange={(e) => setFileId(e.target.value)}
        >
          <option value="">{files === null ? t('common.loading') : t('img.choose')}</option>
          {(files ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.filename}
            </option>
          ))}
        </select>
        {files && !files.length ? <p className="hint">{t('img.none')}</p> : null}
      </div>
      <div className="field">
        <label htmlFor={uploadId}>{t('img.upload')}</label>
        <input
          id={uploadId}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
          }}
        />
      </div>
      {fileId ? (
        <img className="position-image" src={`/api/v1/files/${fileId}/content`} alt="" />
      ) : null}
      <div className="field">
        <label htmlFor={captionId}>{t('img.caption')}</label>
        <input id={captionId} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </div>
      <FormError>{error}</FormError>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={busy || !fileId}
          onClick={() => void submit()}
        >
          {t('img.add')}
        </button>
        <button type="button" className="button ghost auto" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

export function ImagePositionView({ item }: { item: DocumentItem }) {
  return (
    <figure className="position-figure">
      {item.image ? (
        <img
          className="position-image"
          src={item.image.url}
          alt={item.shortText ?? item.image.name}
          loading="lazy"
        />
      ) : null}
      <figcaption className="hint">{item.shortText ?? item.image?.name}</figcaption>
    </figure>
  )
}

/** „In Stammdaten speichern“ of a position (with its Kalkulation). */
export function SaveToCatalogButton({ doc, item }: { doc: Doc; item: DocumentItem }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>(item.catalogItemId ? 'done' : 'idle')
  const [error, setError] = useState<string | null>(null)
  if (state === 'done') {
    return <span className="tag ok">{t('stm.saved')}</span>
  }
  return (
    <>
      <button
        type="button"
        className="button ghost small"
        disabled={state === 'busy'}
        aria-label={`${t('stm.save')}: ${item.shortText ?? ''}`}
        onClick={async () => {
          setState('busy')
          setError(null)
          try {
            await api<CatalogItem>(
              'POST',
              `/api/v1/documents/${doc.id}/items/${item.id}/to-catalog`,
              {},
            )
            setState('done')
          } catch (err) {
            setError((err as ApiError).message)
            setState('idle')
          }
        }}
      >
        {t('stm.save')}
      </button>
      {error ? <span className="error">{error}</span> : null}
    </>
  )
}
