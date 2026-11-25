import type { CatalogImportResult } from '@easybau/schemas'
import { useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'

/**
 * Stammdaten aus CSV (P2.12): file → preview (nothing is written) → import. Columns like the
 * CSV export; existing entries are skipped or, on request, updated.
 */
export function CatalogImport({
  kind,
  onImported,
  onClose,
}: {
  kind: 'service' | 'material'
  onImported: () => void
  onClose: () => void
}) {
  const id = useId()
  const [text, setText] = useState<string | null>(null)
  const [update, setUpdate] = useState(false)
  const [result, setResult] = useState<CatalogImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (dryRun: boolean) => {
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      const res = await api<CatalogImportResult>('POST', '/api/v1/catalog/import', {
        csv: text,
        dryRun,
        kind,
        updateExisting: update,
      })
      setResult(res)
      if (!dryRun) onImported()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  const read = async (file: File | undefined) => {
    setResult(null)
    if (!file) return
    const buffer = await file.arrayBuffer()
    // Excel on Windows often saves CSV as Windows-1252; UTF-8 is tried first.
    const utf8 = new TextDecoder('utf-8').decode(buffer)
    setText(utf8.includes('�') ? new TextDecoder('windows-1252').decode(buffer) : utf8)
  }
  const changes = result ? result.created + result.updated : 0

  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <div className="panel-head">
        <h2 id={`${id}-title`}>{t('cc.importTitle')}</h2>
        <button type="button" className="button ghost auto" onClick={onClose}>
          {t('contacts.close')}
        </button>
      </div>
      <p className="hint">{t('cc.importHint')}</p>
      <div className="field">
        <label htmlFor={`${id}-file`}>{t('cc.file')}</label>
        <input
          id={`${id}-file`}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void read(e.target.files?.[0])}
        />
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={update}
          onChange={(e) => {
            setUpdate(e.target.checked)
            setResult(null)
          }}
        />
        <span>{t('cc.update')}</span>
      </label>
      <FormError>{error}</FormError>
      <div className="button-row">
        <button
          type="button"
          className="button ghost auto"
          disabled={!text || busy}
          onClick={() => run(true)}
        >
          {t('cc.preview')}
        </button>
        {result?.dryRun && changes ? (
          <button
            type="button"
            className="button primary auto"
            disabled={busy}
            onClick={() => run(false)}
          >
            {t('cc.run')}
          </button>
        ) : null}
      </div>
      {result ? (
        <>
          <p role="status">
            {result.dryRun ? '' : `${t('cc.done')} `}
            {tf('cc.summary', {
              created: String(result.created),
              updated: String(result.updated),
              skipped: String(result.skipped),
              errors: String(result.errors),
            })}
          </p>
          {result.newFolders.length ? (
            <p className="hint">{tf('cc.newFolders', { list: result.newFolders.join(', ') })}</p>
          ) : null}
          <ul className="list plain import-rows">
            {result.rows
              .filter((r) => r.action !== 'create' || r.message)
              .slice(0, 200)
              .map((r) => (
                <li key={r.line} className={`import-${r.action}`}>
                  {tf('contacts.import.line', { line: String(r.line) })} · <strong>{r.name}</strong>{' '}
                  · {t(`cc.action.${r.action}` as TextKey)}
                  {r.message ? ` – ${r.message}` : ''}
                </li>
              ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
