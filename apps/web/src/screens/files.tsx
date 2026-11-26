import type { FileSummary, FolderSummary, Me } from '@easybau/schemas'
import { UPLOAD_EXTENSIONS } from '@easybau/schemas/constants'
import { Button, buttonClass } from '@easybau/ui'
import { type DragEvent, useCallback, useEffect, useState } from 'react'
import { type ApiError, api, uploadFile } from '../api'
import { formatBytes, formatDateTime } from '../format'
import { Field, FormError, useForm, value } from '../forms'
import { type TextKey, t } from '../i18n'

const ACCEPT = UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(',')

interface UploadState {
  id: string
  name: string
  status: 'pending' | 'done' | 'failed'
  message?: string
}

/** Ablage of a project: folders, upload (incl. camera on phones), preview, rename, move, delete. */
export function ProjectFiles({ me, projectId }: { me: Me; projectId: string }) {
  const [folders, setFolders] = useState<FolderSummary[]>([])
  const [files, setFiles] = useState<FileSummary[] | null>(null)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [dragging, setDragging] = useState(false)
  const [addingFolder, setAddingFolder] = useState(false)
  const canManageFolders = me.permissions.includes('project.write')
  const canUpload = me.role.access !== 'readonly'

  const reload = useCallback(() => {
    const query = folderId ? `?folderId=${folderId}` : ''
    Promise.all([
      api<FolderSummary[]>('GET', `/api/v1/projects/${projectId}/folders`),
      api<FileSummary[]>('GET', `/api/v1/projects/${projectId}/files${query}`),
    ])
      .then(([f, list]) => {
        setFolders(f)
        setFiles(list)
      })
      .catch((err: ApiError) => setError(err.message))
  }, [projectId, folderId])
  useEffect(reload, [reload])

  const upload = async (list: FileList | File[]) => {
    const selected = [...list]
    if (!selected.length) return
    setError(null)
    setUploads(selected.map((f) => ({ id: crypto.randomUUID(), name: f.name, status: 'pending' })))
    // One after another: gentle on weak mobile connections and on the server.
    for (const [index, file] of selected.entries()) {
      const query = new URLSearchParams({ filename: file.name })
      if (folderId) query.set('folderId', folderId)
      try {
        await uploadFile<FileSummary>(`/api/v1/projects/${projectId}/files?${query}`, file)
        setUploads((u) => u.map((s, i) => (i === index ? { ...s, status: 'done' } : s)))
      } catch (err) {
        const message = (err as ApiError).message
        setUploads((u) => u.map((s, i) => (i === index ? { ...s, status: 'failed', message } : s)))
      }
    }
    reload()
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    if (canUpload) upload(event.dataTransfer.files)
  }

  const current = folders.find((f) => f.id === folderId)
  const deleteFolder = async () => {
    if (!current || !window.confirm(t('files.deleteFolderConfirm'))) return
    try {
      await api('DELETE', `/api/v1/projects/${projectId}/folders/${current.id}`)
      setFolderId(null)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  return (
    // Drag and drop is an extra for desktops; the upload buttons work with keyboard and touch.
    // biome-ignore lint/a11y/noStaticElementInteractions: optional drop zone, see above
    <div
      className={`files${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <h2>{t('files.title')}</h2>
      <nav className="chips" aria-label={t('files.title')}>
        <button
          type="button"
          aria-current={folderId === null ? 'true' : undefined}
          onClick={() => setFolderId(null)}
        >
          {t('files.all')}
        </button>
        {folders.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-current={folderId === f.id ? 'true' : undefined}
            onClick={() => setFolderId(f.id)}
          >
            {f.name} <span className="count">{f.fileCount}</span>
          </button>
        ))}
        {canManageFolders && !addingFolder ? (
          <button type="button" className="add" onClick={() => setAddingFolder(true)}>
            + {t('files.newFolder')}
          </button>
        ) : null}
      </nav>
      {addingFolder ? (
        <NewFolder
          projectId={projectId}
          onDone={(folder) => {
            setAddingFolder(false)
            if (folder) setFolderId(folder.id)
            else reload()
          }}
        />
      ) : null}

      {canUpload ? (
        <div className="upload-bar">
          <label className={buttonClass({ variant: 'primary', className: 'file-button' })}>
            {t('files.upload')}
            <input
              type="file"
              multiple
              accept={ACCEPT}
              className="visually-hidden"
              onChange={(e) => {
                if (e.target.files) upload(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          <label
            className={buttonClass({
              variant: 'ghost',
              width: 'natural',
              className: 'file-button',
            })}
          >
            {t('files.photo')}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="visually-hidden"
              onChange={(e) => {
                if (e.target.files) upload(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          {current && canManageFolders && current.fileCount === 0 ? (
            <Button type="button" variant="ghost" width="natural" danger onClick={deleteFolder}>
              {t('files.deleteFolder')}
            </Button>
          ) : null}
          <p className="hint">
            {t('files.drop')} {current ? `${t('files.target')}: ${current.name}` : ''}
          </p>
        </div>
      ) : null}

      {uploads.length ? (
        <ul className="uploads" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.id} className={`upload upload--${u.status}`}>
              {u.name}:{' '}
              {u.status === 'pending'
                ? `${t('files.uploading')} …`
                : u.status === 'done'
                  ? '✓'
                  : `${t('files.uploadFailed')} – ${u.message}`}
            </li>
          ))}
        </ul>
      ) : null}

      <FormError>{error}</FormError>
      {!files ? <p className="muted">{t('common.loading')}</p> : null}
      {files && !files.length ? <p className="muted">{t('files.empty')}</p> : null}
      {files?.length ? (
        <ul className="file-grid">
          {files.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              folders={folders}
              canUpload={canUpload}
              onChanged={reload}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function NewFolder({
  projectId,
  onDone,
}: {
  projectId: string
  onDone: (folder: FolderSummary | null) => void
}) {
  const form = useForm(
    (data) =>
      api<FolderSummary>('POST', `/api/v1/projects/${projectId}/folders`, {
        name: value(data, 'name'),
      }),
    onDone,
  )
  return (
    <form className="inline-form" onSubmit={form.onSubmit} noValidate>
      <FormError>{form.error}</FormError>
      <Field label={t('files.folderName')} name="name" required error={form.fieldErrors.name} />
      <div className="button-row">
        <Button type="submit" variant="primary" disabled={form.busy}>
          {t('common.add')}
        </Button>
        <Button type="button" variant="ghost" width="natural" onClick={() => onDone(null)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

function FileCard({
  file,
  folders,
  canUpload,
  onChanged,
}: {
  file: FileSummary
  folders: FolderSummary[]
  canUpload: boolean
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const url = `/api/v1/files/${file.id}/content`
  const canEdit = canUpload && file.canDelete

  const form = useForm(
    (data) =>
      api<FileSummary>('PATCH', `/api/v1/files/${file.id}`, {
        filename: value(data, 'filename'),
        caption: value(data, 'caption') || null,
        folderId: value(data, 'folderId') || null,
      }),
    () => {
      setEditing(false)
      onChanged()
    },
  )
  const remove = async () => {
    if (!window.confirm(t('files.deleteConfirm'))) return
    try {
      await api('DELETE', `/api/v1/files/${file.id}`)
      onChanged()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  return (
    <li className="file-card">
      <a
        className="file-preview"
        href={url}
        target="_blank"
        rel="noopener"
        aria-label={`${t('files.open')}: ${file.filename}`}
      >
        {file.category === 'image' && file.inline ? (
          <img src={url} alt={file.caption ?? file.filename} loading="lazy" />
        ) : (
          <span className="file-kind" aria-hidden="true">
            {t(`files.kind.${file.category}` as TextKey)}
          </span>
        )}
      </a>
      <div className="file-info">
        <strong className="file-name">{file.filename}</strong>
        {file.caption ? <span>{file.caption}</span> : null}
        <span className="muted">
          {[
            formatBytes(file.sizeBytes),
            formatDateTime(file.createdAt),
            file.uploadedBy?.displayName,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {file.isEvidence ? <span className="tag">{t('files.evidence')}</span> : null}
      </div>
      <FormError>{error}</FormError>
      {editing ? (
        <form className="stack" onSubmit={form.onSubmit} noValidate>
          <FormError>{form.error}</FormError>
          <Field
            label={t('files.rename')}
            name="filename"
            defaultValue={file.filename}
            error={form.fieldErrors.filename}
          />
          <Field label={t('files.caption')} name="caption" defaultValue={file.caption ?? ''} />
          <div className="field">
            <label htmlFor={`move-${file.id}`}>{t('files.move')}</label>
            <select
              id={`move-${file.id}`}
              name="folderId"
              className="select"
              defaultValue={file.folderId ?? ''}
            >
              <option value="">{t('files.noFolder')}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="button-row">
            <Button type="submit" variant="primary" disabled={form.busy}>
              {t('common.save')}
            </Button>
            <Button type="button" variant="ghost" width="natural" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="actions start">
          <a
            className={buttonClass({ variant: 'ghost', width: 'natural', size: 'small' })}
            href={`${url}?download=1`}
          >
            {t('files.download')}
          </a>
          {canEdit ? (
            <>
              <Button
                type="button"
                variant="ghost"
                width="natural"
                size="small"
                onClick={() => setEditing(true)}
              >
                {t('common.edit')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                width="natural"
                size="small"
                danger
                onClick={remove}
              >
                {t('common.delete')}
              </Button>
            </>
          ) : null}
        </div>
      )}
    </li>
  )
}
