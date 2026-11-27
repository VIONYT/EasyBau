import type {
  CatalogFolder,
  CatalogItem,
  DocumentDetail,
  DocumentItem,
  FileSummary,
  TargetPriceResult,
} from '@easybau/schemas'
import { Button } from '@easybau/ui'
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
  // Positionen festhalten: their price stays (e.g. agreed prices, subcontractor quotes).
  const [locked, setLocked] = useState<string[]>([])
  const calculated = doc.items.filter((i) => i.costLines.length > 0)
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
        lockedItemIds: locked,
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
      {calculated.length ? (
        <details className="target-lock">
          <summary>{tf('tp.lock', { n: String(locked.length) })}</summary>
          <fieldset className="plain">
            <legend className="visually-hidden">{t('tp.lockLegend')}</legend>
            {calculated.map((item) => (
              <label key={item.id} className="check">
                <input
                  type="checkbox"
                  checked={locked.includes(item.id)}
                  onChange={(e) => {
                    setLocked(
                      e.target.checked ? [...locked, item.id] : locked.filter((v) => v !== item.id),
                    )
                    setResult(null)
                  }}
                />
                <span>
                  {[item.oz, item.shortText].filter(Boolean).join(' ')} ·{' '}
                  {formatCents(item.totalCents)}
                </span>
              </label>
            ))}
          </fieldset>
        </details>
      ) : null}
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
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !target}
          onClick={() => void run(false)}
        >
          {t('tp.previewButton')}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={busy || !result || result.applied}
          onClick={() => void run(true)}
        >
          {t('tp.apply')}
        </Button>
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
  // Replaced: an older version once a newer one has been finalized.
  const newestFinal = doc.versions.filter((v) => v.status !== 'draft').at(-1)
  const superseded = (version: number) => !!newestFinal && version < newestFinal.version
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
              <span className="muted">
                {superseded(v.version)
                  ? t('ver.superseded')
                  : t(`doc.status.${v.status}` as TextKey)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {newest && newest.id !== doc.id ? <p className="hint">{t('ver.outdated')}</p> : null}
      <FormError>{error}</FormError>
      {canCreate ? (
        <Button
          type="button"
          variant="ghost"
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
        </Button>
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
        <Button
          type="button"
          variant="primary"
          disabled={busy || !fileId}
          onClick={() => void submit()}
        >
          {t('img.add')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
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

/** Bildunterschrift einer Bild-Position ändern. */
export function ImageCaptionForm({
  doc,
  item,
  onDone,
  onCancel,
}: {
  doc: Doc
  item: DocumentItem
  onDone: (result: { data: Doc; etag: string | null }) => void
  onCancel: () => void
}) {
  const id = useId()
  const [caption, setCaption] = useState(item.shortText ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          onDone(
            await apiWithEtag<Doc>('PATCH', `/api/v1/documents/${doc.id}/items/${item.id}`, {
              shortText: caption.trim() || null,
            }),
          )
        } catch (err) {
          setError((err as ApiError).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <ImagePositionView item={{ ...item, shortText: null }} />
      <div className="field">
        <label htmlFor={id}>{t('img.caption')}</label>
        <input id={id} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </div>
      <FormError>{error}</FormError>
      <div className="button-row">
        <Button type="submit" variant="primary" disabled={busy}>
          {t('common.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

/** „In Stammdaten speichern“ of a position (with its Kalkulation): folder, duplicate check. */
export function SaveToCatalogButton({ doc, item }: { doc: Doc; item: DocumentItem }) {
  const id = useId()
  const [state, setState] = useState<'idle' | 'open' | 'busy' | 'done'>(
    item.catalogItemId ? 'done' : 'idle',
  )
  const [folders, setFolders] = useState<CatalogFolder[]>([])
  const [folderId, setFolderId] = useState('')
  const [duplicate, setDuplicate] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (state === 'done') {
    return <span className="tag ok">{t('stm.saved')}</span>
  }
  const open = async () => {
    setState('open')
    try {
      setFolders(
        (await api<CatalogFolder[]>('GET', '/api/v1/catalog/folders')).filter(
          (f) => f.kind === 'service',
        ),
      )
    } catch {
      setFolders([])
    }
  }
  const save = async (allowDuplicate: boolean) => {
    setState('busy')
    setError(null)
    try {
      await api<CatalogItem>('POST', `/api/v1/documents/${doc.id}/items/${item.id}/to-catalog`, {
        folderId: folderId || null,
        allowDuplicate,
      })
      setState('done')
    } catch (err) {
      const e = err as ApiError
      if (e.status === 409) setDuplicate(e.message)
      else setError(e.message)
      setState('open')
    }
  }
  if (state === 'idle') {
    return (
      <Button
        type="button"
        variant="ghost"
        width="natural"
        size="small"
        aria-label={`${t('stm.save')}: ${item.shortText ?? ''}`}
        onClick={() => void open()}
      >
        {t('stm.save')}
      </Button>
    )
  }
  const depth = (f: CatalogFolder): number => {
    const parent = folders.find((p) => p.id === f.parentId)
    return parent ? depth(parent) + 1 : 0
  }
  return (
    <div className="stack save-to-catalog">
      <div className="field">
        <label htmlFor={id}>{t('stm.folder')}</label>
        <select
          id={id}
          className="select"
          value={folderId}
          onChange={(e) => setFolderId(e.target.value)}
        >
          <option value="">{t('stm.folderDefault')}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {`${'\u00a0\u00a0'.repeat(depth(f))}${f.name}`}
            </option>
          ))}
        </select>
      </div>
      {duplicate ? <p className="warning">{duplicate}</p> : null}
      {error ? <span className="error">{error}</span> : null}
      <div className="button-row">
        <Button
          type="button"
          variant="primary"
          width="natural"
          size="small"
          disabled={state === 'busy'}
          onClick={() => void save(Boolean(duplicate))}
        >
          {duplicate ? t('stm.saveAnyway') : t('stm.save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          width="natural"
          size="small"
          onClick={() => setState('idle')}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
