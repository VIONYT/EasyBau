import type {
  BackupRunSummary,
  EmailMessageSummary,
  EmailSettings,
  Me,
  OperationsStatus,
} from '@easybau/schemas'
import { Button, buttonClass } from '@easybau/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api, downloadFile } from '../api'
import { formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'

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
      <OperationsPanel canWrite={me.permissions.includes('settings.write')} />
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
        <Button type="button" variant="ghost" width="natural" onClick={test}>
          {t('sys.emailTest')}
        </Button>
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

export function ExportPanel() {
  const id = useId()
  const [period, setPeriod] = useState(lastMonth)
  const [withBelege, setWithBelege] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (kind: 'datev' | 'gobd') => {
    setError(null)
    setBusy(kind)
    try {
      await downloadFile(
        `/api/v1/exports/${kind}?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}${kind === 'datev' && withBelege ? '&belege=true' : ''}`,
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
      <label className="check">
        <input
          type="checkbox"
          checked={withBelege}
          onChange={(e) => setWithBelege(e.target.checked)}
        />
        <span>{t('sys.exportDatevBelege')}</span>
      </label>
      <div className="actions">
        <Button
          type="button"
          variant="ghost"
          width="natural"
          disabled={busy !== null}
          onClick={() => run('datev')}
        >
          {busy === 'datev' ? t('sys.exportBusy') : t('sys.exportDatev')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          width="natural"
          disabled={busy !== null}
          onClick={() => run('gobd')}
        >
          {busy === 'gobd' ? t('sys.exportBusy') : t('sys.exportGobd')}
        </Button>
      </div>
      <FormError>{error}</FormError>
      <h3>{t('sys.exportFull')}</h3>
      <p className="muted">{t('sys.exportFullHint')}</p>
      {/* Plain link: the archive is streamed by the browser, not held in memory. */}
      <a
        className={buttonClass({ variant: 'ghost', width: 'natural' })}
        href="/api/v1/exports/full"
        download
      >
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

type CheckState = 'ok' | 'warning' | 'error' | 'off'

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

/** Sicherung außer Haus (ADR 0011): only a copy on a second place protects against fire or theft. */
function offsiteState(last: BackupRunSummary | null): 'ok' | 'warning' {
  return last?.offsite?.status === 'ok' ? 'ok' : 'warning'
}

function offsiteText(last: BackupRunSummary | null): string {
  const offsite = last?.offsite
  if (!offsite || offsite.status === 'off') return t('sys.offsiteOff')
  if (offsite.status === 'failed') {
    return tf('sys.offsiteFailed', { message: offsite.message ?? '' })
  }
  return tf('sys.offsiteOk', {
    target: offsite.target ?? '',
    at: offsite.at ? formatDateTime(offsite.at) : '',
  })
}

/** Betriebs-Check: is the installation backed up, can it send e-mails, is it secure? */
function OperationsPanel({ canWrite }: { canWrite: boolean }) {
  const [status, setStatus] = useState<OperationsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api<OperationsStatus>('GET', '/api/v1/settings/operations')
      .then(setStatus)
      .catch((err: ApiError) => setError(err.message))
  }, [])
  useEffect(reload, [reload])
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
        <Check state={offsiteState(last)} title={t('sys.offsite')}>
          {offsiteText(last)}
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
        <Check
          state={status.einvoice.configured && status.einvoice.reachable ? 'ok' : 'warning'}
          title={t('sys.einvoice')}
        >
          {!status.einvoice.configured
            ? t('sys.einvoiceOff')
            : status.einvoice.reachable
              ? t('sys.einvoiceOk')
              : t('sys.einvoiceDown')}
        </Check>
        <Check
          state={status.audit.problem ? 'error' : status.audit.stale ? 'warning' : 'ok'}
          title={t('sys.auditChain')}
        >
          {auditText(status.audit)}
        </Check>
        <Check state={archiveState(status.archive)} title={t('sys.archive')}>
          {archiveText(status.archive)}
        </Check>
        {status.archive.configured ? (
          <Check state={verifyState(status.archive.verify)} title={t('sys.archiveVerify')}>
            {verifyText(status.archive.verify)}
          </Check>
        ) : null}
        <Check state={status.security.https ? 'ok' : 'warning'} title={t('sys.https')}>
          {status.security.https ? t('sys.httpsOk') : t('sys.httpsOff')}
        </Check>
        <Check state={status.security.requireAdminMfa ? 'ok' : 'warning'} title={t('sys.mfa')}>
          {status.security.requireAdminMfa ? t('sys.mfaOk') : t('sys.mfaOff')}
        </Check>
      </ul>
      {status.archive.configured && canWrite ? (
        <ArchiveVerifyButton
          running={Boolean(
            status.archive.verify.request && !status.archive.verify.request.finishedAt,
          )}
          onStarted={reload}
        />
      ) : null}
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
      <p className="muted">{status.email.enabled ? t('sys.alertOn') : t('sys.alertOff')}</p>
    </div>
  )
}

/** Audit-Kette (rule 6): result of the newest check. */
export function auditText(a: {
  lastCheckAt: string | null
  problem: string | null
  brokenSeq: number | null
  events: number
}): string {
  if (!a.lastCheckAt) return t('sys.auditNever')
  const when = formatDateTime(a.lastCheckAt)
  if (a.problem) {
    return tf(`sys.audit.${a.problem}` as TextKey, { when, seq: String(a.brokenSeq ?? '') })
  }
  return tf('sys.auditOk', { when, n: String(a.events) })
}

type VerifyOps = OperationsStatus['archive']['verify']

function verifyState(v: VerifyOps): 'ok' | 'warning' | 'error' {
  if (v.lost) return 'error'
  if (!v.lastCheckAt || v.unchecked) return 'warning'
  return 'ok'
}

function verifyText(v: VerifyOps): string {
  const parts: string[] = []
  if (v.lost) parts.push(tf('sys.verifyLost', { n: String(v.lost) }))
  if (v.request && !v.request.finishedAt) {
    parts.push(tf('sys.verifyRunning', { n: String(v.request.checked) }))
  } else if (v.lastCheckAt) {
    parts.push(
      tf('sys.verifyOk', {
        when: formatDateTime(v.lastCheckAt),
        n: String(v.checked30d),
        restored: String(v.restored30d),
      }),
    )
  } else {
    parts.push(t('sys.verifyNever'))
  }
  if (v.unchecked && !(v.request && !v.request.finishedAt)) {
    parts.push(tf('sys.verifyUnchecked', { n: String(v.unchecked) }))
  }
  return parts.join(' ')
}

function ArchiveVerifyButton({ running, onStarted }: { running: boolean; onStarted: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    setError(null)
    try {
      await api('POST', '/api/v1/settings/operations/archive-verify', {})
      onStarted()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  return (
    <div className="actions start">
      <Button type="button" variant="ghost" disabled={running} onClick={start}>
        {running ? t('sys.verifyBusy') : t('sys.verifyStart')}
      </Button>
      <FormError>{error}</FormError>
    </div>
  )
}

type ArchiveOps = OperationsStatus['archive']

/** Pending originals older than one hour mean the archive does not keep up. */
const archiveStuck = (a: ArchiveOps) =>
  a.oldestPendingAt !== null && Date.now() - new Date(a.oldestPendingAt).getTime() > 60 * 60 * 1000

function archiveState(a: ArchiveOps): 'ok' | 'warning' {
  if (!a.configured || !a.reachable || !a.objectLock) return 'warning'
  return a.failing || archiveStuck(a) ? 'warning' : 'ok'
}

function archiveText(a: ArchiveOps): string {
  if (!a.configured) return t('sys.archiveOff')
  if (!a.reachable) return t('sys.archiveDown')
  if (!a.objectLock) return tf('sys.archiveNoLock', { bucket: a.bucket ?? '' })
  const base = tf('sys.archiveOk', { bucket: a.bucket ?? '', mode: a.mode ?? '' })
  if (a.failing)
    return `${base} ${tf('sys.archiveFailing', { n: String(a.failing), error: a.lastError ?? '' })}`
  if (a.pending) return `${base} ${tf('sys.archivePending', { n: String(a.pending) })}`
  return base
}
