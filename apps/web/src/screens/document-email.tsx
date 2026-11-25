import type { DocumentDetail, DocumentEmailDraft } from '@easybau/schemas'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'

const list = (text: string) =>
  text
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)

/**
 * „Per E-Mail senden“ (P2.1): prefilled from the templates, the archived original (for invoices
 * the ZUGFeRD PDF, optionally the XRechnung) as attachment, history with delivery status.
 */
export function DocumentEmailPanel({
  doc,
  canWrite,
  onSent,
}: {
  doc: DocumentDetail
  canWrite: boolean
  onSent: () => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<DocumentEmailDraft | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    text: '',
    xrechnung: false,
    fileIds: [] as string[],
  })

  const load = useCallback(() => {
    api<DocumentEmailDraft>('GET', `/api/v1/documents/${doc.id}/email`)
      .then((d) => {
        setDraft(d)
        setForm({
          to: d.to ?? '',
          cc: d.cc.join(', '),
          bcc: d.bcc.join(', '),
          subject: d.subject,
          text: d.text,
          xrechnung: d.xrechnung.recommended,
          fileIds: d.files.filter((f) => f.selected).map((f) => f.id),
        })
      })
      .catch((err: ApiError) => setError(err.message))
  }, [doc.id])
  useEffect(load, [load])

  if (!draft) return error ? <FormError>{error}</FormError> : null
  const send = async () => {
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      const result = await api<DocumentEmailDraft>('POST', `/api/v1/documents/${doc.id}/email`, {
        to: form.to.trim(),
        cc: list(form.cc),
        bcc: list(form.bcc),
        subject: form.subject,
        text: form.text,
        attachXrechnung: form.xrechnung,
        fileIds: form.fileIds,
      })
      setDraft(result)
      setOpen(false)
      onSent()
    } catch (err) {
      const e = err as ApiError
      setError(e.message)
      setFieldErrors(e.fieldErrors ?? {})
    } finally {
      setBusy(false)
    }
  }
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch })
  const field = (name: 'to' | 'cc' | 'bcc' | 'subject', label: TextKey, hint?: TextKey) => (
    <div className="field">
      <label htmlFor={`${id}-${name}`}>{t(label)}</label>
      <input
        id={`${id}-${name}`}
        type={name === 'to' ? 'email' : 'text'}
        inputMode={name === 'subject' ? undefined : 'email'}
        autoComplete="off"
        value={form[name]}
        aria-invalid={fieldErrors[name] ? true : undefined}
        onChange={(e) => set({ [name]: e.target.value })}
      />
      {hint ? <p className="hint">{t(hint)}</p> : null}
      {fieldErrors[name] ? <p className="field-error">{fieldErrors[name]}</p> : null}
    </div>
  )

  return (
    <section className="panel doc-email" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('mail.title')}</h2>
      {draft.blocked ? <p className="hint">{draft.blocked}</p> : null}
      {!draft.enabled ? <p className="hint">{t('mail.disabled')}</p> : null}
      {draft.history.length ? (
        <ul className="list mail-history">
          {draft.history.map((m) => (
            <li key={m.id} className="list-row">
              <span>
                <span className={`chip chip--mail-${m.status}`}>
                  {tf(`dun.mail.${m.status}` as TextKey, { to: m.to })}
                </span>
                <span className="muted block">
                  {[
                    formatDateTime(m.sentAt ?? m.createdAt),
                    m.createdBy,
                    m.cc.length ? `${t('mail.cc')}: ${m.cc.join(', ')}` : null,
                    m.bcc.length ? `${t('mail.bcc')}: ${m.bcc.join(', ')}` : null,
                    m.attachments.join(', '),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {m.status === 'failed' && m.lastError ? (
                  <span className="warning block">{m.lastError}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {canWrite && draft.enabled && !draft.blocked && !open ? (
        <button type="button" className="button primary auto" onClick={() => setOpen(true)}>
          {t(draft.history.length ? 'mail.sendAgain' : 'mail.send')}
        </button>
      ) : null}
      {open ? (
        <div className="mail-form">
          {field('to', 'mail.to')}
          {field('cc', 'mail.cc', 'mail.listHint')}
          {field('bcc', 'mail.bcc', 'mail.listHint')}
          {field('subject', 'mail.subject')}
          <div className="field">
            <label htmlFor={`${id}-text`}>{t('mail.text')}</label>
            <textarea
              id={`${id}-text`}
              rows={9}
              value={form.text}
              onChange={(e) => set({ text: e.target.value })}
            />
          </div>
          <p>
            <strong>{t('mail.attachments')}</strong>
            <span className="block">
              {[
                ...draft.attachments.map((a) => a.filename),
                ...(form.xrechnung ? draft.xrechnung.filenames : []),
                ...draft.files.filter((f) => form.fileIds.includes(f.id)).map((f) => f.filename),
              ].join(', ')}
            </span>
          </p>
          {draft.xrechnung.available ? (
            <label className="check">
              <input
                type="checkbox"
                checked={form.xrechnung}
                onChange={(e) => set({ xrechnung: e.target.checked })}
              />
              <span>
                {t('mail.attachXrechnung')}
                {draft.xrechnung.recommended ? ` (${t('mail.recommended')})` : ''}
              </span>
            </label>
          ) : null}
          {draft.files.length ? (
            <fieldset className="plain">
              <legend>{t('mail.files')}</legend>
              {draft.files.map((file) => (
                <label key={file.id} className="check">
                  <input
                    type="checkbox"
                    checked={form.fileIds.includes(file.id)}
                    onChange={(e) =>
                      set({
                        fileIds: e.target.checked
                          ? [...form.fileIds, file.id]
                          : form.fileIds.filter((id) => id !== file.id),
                      })
                    }
                  />
                  <span>{file.filename}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <FormError>{error}</FormError>
          <div className="button-row">
            <button
              type="button"
              className="button primary auto"
              disabled={busy || !form.to.trim()}
              onClick={send}
            >
              {t('mail.submit')}
            </button>
            <button type="button" className="button ghost auto" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
