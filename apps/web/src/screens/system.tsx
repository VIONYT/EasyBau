import type {
  BackupRunSummary,
  EmailMessageSummary,
  EmailSettings,
  Me,
  OperationsStatus,
} from '@opc/schemas'
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
      <OperationsPanel />
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

const DAY_MS = 26 * 60 * 60 * 1000

function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: unit ? 1 : 0 }).format(value)} ${units[unit]}`
}

type CheckState = 'ok' | 'warning' | 'off'

function Check({ state, title, children }: { state: CheckState; title: string; children: string }) {
  return (
    <li className={`op-check op-check--${state}`}>
      <span className="op-check__state">{t(`sys.check.${state}` as TextKey)}</span>
      <span>
        <strong>{title}</strong>
        <span className="muted">{children}</span>
      </span>
    </li>
  )
}

/** Betriebs-Check: is the installation backed up, can it send e-mails, is it secure? */
function OperationsPanel() {
  const [status, setStatus] = useState<OperationsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<OperationsStatus>('GET', '/api/v1/settings/operations')
      .then(setStatus)
      .catch((err: ApiError) => setError(err.message))
  }, [])
  if (!status) return error ? <FormError>{error}</FormError> : null
  const last = status.backup.lastSuccess
  const backupFresh = last !== null && Date.now() - new Date(last.finishedAt).getTime() < DAY_MS
  const describe = (run: BackupRunSummary) =>
    [
      formatDateTime(run.finishedAt),
      run.status === 'ok'
        ? `${formatBytes(run.dbBytes)} + ${formatBytes(run.filesBytes)}`
        : run.message,
    ]
      .filter(Boolean)
      .join(' · ')
  return (
    <div className="panel">
      <h2>{t('sys.check')}</h2>
      <ul className="op-check-list">
        <Check state={backupFresh ? 'ok' : 'warning'} title={t('sys.backup')}>
          {last
            ? `${t('sys.backupLast')} ${describe(last)}${backupFresh ? '' : ` – ${t('sys.backupOld')}`}`
            : t('sys.backupNone')}
        </Check>
        <Check
          state={!status.email.enabled ? 'off' : status.email.failed ? 'warning' : 'ok'}
          title={t('sys.email')}
        >
          {!status.email.enabled
            ? t('sys.emailOffShort')
            : status.email.failed
              ? t('sys.emailFailed').replace('{n}', String(status.email.failed))
              : t('sys.emailOk')}
        </Check>
        <Check state={status.security.https ? 'ok' : 'warning'} title={t('sys.https')}>
          {status.security.https ? t('sys.httpsOk') : t('sys.httpsOff')}
        </Check>
        <Check state={status.security.requireAdminMfa ? 'ok' : 'warning'} title={t('sys.mfa')}>
          {status.security.requireAdminMfa ? t('sys.mfaOk') : t('sys.mfaOff')}
        </Check>
      </ul>
      {status.backup.recent.length ? (
        <>
          <h3>{t('sys.backupRecent')}</h3>
          <ul className="list">
            {status.backup.recent.map((run) => (
              <li key={run.name}>
                <strong>{run.name}</strong>
                <span className="muted">
                  {t(`sys.backup.${run.status}` as TextKey)} · {describe(run)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="muted">{t('sys.backupHint')}</p>
    </div>
  )
}
