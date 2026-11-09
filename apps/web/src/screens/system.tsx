import type { EmailMessageSummary, EmailSettings, Me } from '@opc/schemas'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api, downloadFile } from '../api'
import { formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t } from '../i18n'

interface Meta {
  name: string
  version: string
  profile: string
  role: string
}

/** Betrieb: version, e-mail, exports and backups. */
export function SystemSettings({ me }: { me: Me }) {
  const [meta, setMeta] = useState<Meta | null>(null)
  useEffect(() => {
    api<Meta>('GET', '/api/v1/meta')
      .then(setMeta)
      .catch(() => undefined)
  }, [])
  return (
    <>
      <div className="panel">
        <h2>{t('sys.title')}</h2>
        {meta ? (
          <dl className="facts">
            <dt>{t('sys.version')}</dt>
            <dd>
              {meta.name} {meta.version}
            </dd>
            <dt>{t('sys.profile')}</dt>
            <dd>{meta.profile}</dd>
          </dl>
        ) : null}
      </div>
      <EmailPanel canWrite={me.permissions.includes('settings.write')} />
      {me.permissions.includes('export.run') ? <ExportPanel /> : null}
    </>
  )
}

function EmailPanel({ canWrite }: { canWrite: boolean }) {
  const [settings, setSettings] = useState<EmailSettings | null>(null)
  const [messages, setMessages] = useState<EmailMessageSummary[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api<EmailSettings>('GET', '/api/v1/settings/email')
      .then(setSettings)
      .catch((err: ApiError) => setError(err.message))
    api<EmailMessageSummary[]>('GET', '/api/v1/settings/email/messages')
      .then(setMessages)
      .catch(() => undefined)
  }, [])
  useEffect(reload, [reload])
  const test = async () => {
    setMessage(null)
    setError(null)
    try {
      await api('POST', '/api/v1/settings/email/test', {})
      setMessage(t('sys.emailQueued'))
      reload()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  return (
    <div className="panel">
      <h2>{t('sys.email')}</h2>
      {settings ? (
        settings.enabled ? (
          <p>
            {t('sys.emailOn')} <strong>{settings.from}</strong>
          </p>
        ) : (
          <p className="muted">{t('sys.emailOff')}</p>
        )
      ) : null}
      {settings?.enabled && canWrite ? (
        <button type="button" className="button ghost" onClick={test}>
          {t('sys.emailTest')}
        </button>
      ) : null}
      {message ? (
        <p className="success" role="status">
          {message}
        </p>
      ) : null}
      <FormError>{error}</FormError>
      <h3>{t('sys.outbox')}</h3>
      {messages.length ? (
        <ul className="list">
          {messages.map((m) => (
            <li key={m.id}>
              <strong>{m.subject}</strong>
              <span className="muted">
                {[
                  m.toAddress,
                  t(`sys.mail.${m.status}` as TextKey),
                  formatDateTime(m.sentAt ?? m.createdAt),
                  m.lastError,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('sys.outboxEmpty')}</p>
      )}
    </div>
  )
}

/** Default period: the previous calendar month. */
function lastMonth(): { from: string; to: string } {
  const now = new Date()
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1))
  const last = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0))
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) }
}

function ExportPanel() {
  const id = useId()
  const [period, setPeriod] = useState(lastMonth)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (kind: 'datev' | 'gobd') => {
    setError(null)
    setBusy(kind)
    try {
      await downloadFile(
        `/api/v1/exports/${kind}?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`,
      )
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="panel">
      <h2>{t('sys.exports')}</h2>
      <p className="muted">{t('sys.exportsHint')}</p>
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-from`}>{t('sys.from')}</label>
          <input
            id={`${id}-from`}
            type="date"
            value={period.from}
            onChange={(e) => setPeriod({ ...period, from: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-to`}>{t('sys.to')}</label>
          <input
            id={`${id}-to`}
            type="date"
            value={period.to}
            onChange={(e) => setPeriod({ ...period, to: e.target.value })}
          />
        </div>
      </div>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={busy !== null}
          onClick={() => run('datev')}
        >
          {busy === 'datev' ? t('sys.exportBusy') : t('sys.exportDatev')}
        </button>
        <button
          type="button"
          className="button ghost"
          disabled={busy !== null}
          onClick={() => run('gobd')}
        >
          {busy === 'gobd' ? t('sys.exportBusy') : t('sys.exportGobd')}
        </button>
      </div>
      <FormError>{error}</FormError>
      <h3>{t('sys.exportFull')}</h3>
      <p className="muted">{t('sys.exportFullHint')}</p>
      {/* Plain link: the archive is streamed by the browser, not held in memory. */}
      <a className="button ghost" href="/api/v1/exports/full" download>
        {t('sys.exportFullButton')}
      </a>
    </div>
  )
}
