import type { ContactImportResult } from '@opc/schemas'
import { useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'

/**
 * CSV-Import von Kontakten (P2.9): file → preview (nothing is written) → import. Columns like the
 * CSV export; duplicates (Kundennummer, Name + PLZ) are skipped.
 */
export function ContactImport({
  onImported,
  onClose,
}: {
  onImported: () => void
  onClose: () => void
}) {
  const id = useId()
  const [text, setText] = useState<string | null>(null)
  const [filename, setFilename] = useState('')
  const [numbers, setNumbers] = useState(true)
  const [result, setResult] = useState<ContactImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (dryRun: boolean) => {
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      const res = await api<ContactImportResult>('POST', '/api/v1/contacts/import', {
        csv: text,
        dryRun,
        assignCustomerNumbers: numbers,
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
    setFilename(file.name)
    const buffer = await file.arrayBuffer()
    // Excel on Windows often saves CSV as Windows-1252; UTF-8 is tried first.
    const utf8 = new TextDecoder('utf-8').decode(buffer)
    setText(utf8.includes('�') ? new TextDecoder('windows-1252').decode(buffer) : utf8)
  }

  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <div className="panel-head">
        <h2 id={`${id}-title`}>{t('contacts.import.title')}</h2>
        <button type="button" className="button ghost auto" onClick={onClose}>
          {t('contacts.close')}
        </button>
      </div>
      <p className="hint">{t('contacts.import.hint')}</p>
      <div className="field">
        <label htmlFor={`${id}-file`}>{t('contacts.import.file')}</label>
        <input
          id={`${id}-file`}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void read(e.target.files?.[0])}
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} />
        <span>{t('contacts.import.numbers')}</span>
      </label>
      <FormError>{error}</FormError>
      <div className="button-row">
        <button
          type="button"
          className="button ghost auto"
          disabled={!text || busy}
          onClick={() => run(true)}
        >
          {t('contacts.import.preview')}
        </button>
        {result?.dryRun && result.created ? (
          <button
            type="button"
            className="button primary auto"
            disabled={busy}
            onClick={() => run(false)}
          >
            {tf('contacts.import.submit', { count: String(result.created) })}
          </button>
        ) : null}
      </div>
      {result ? (
        <>
          <p role="status">
            {tf(result.dryRun ? 'contacts.import.summaryPreview' : 'contacts.import.summaryDone', {
              file: filename,
              created: String(result.created),
              skipped: String(result.skipped),
              errors: String(result.errors),
            })}
          </p>
          <ul className="list plain import-rows">
            {result.rows
              .filter((r) => r.action !== 'create' || r.message)
              .slice(0, 200)
              .map((r) => (
                <li key={r.line} className={`import-${r.action}`}>
                  {tf('contacts.import.line', { line: String(r.line) })} · <strong>{r.name}</strong>{' '}
                  · {t(`contacts.import.action.${r.action}` as TextKey)}
                  {r.message ? ` – ${r.message}` : ''}
                </li>
              ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
