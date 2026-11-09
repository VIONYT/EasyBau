import type { EmailMessageSummary, EmailSettings, Me } from '@opc/schemas'
import { useCallback, useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
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
