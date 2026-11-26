import { Button } from '@easybau/ui'
import { t, tf } from '../i18n'
import { discardChange, retryChange, syncNow, useOfflineStatus } from './client'

/** Network state, waiting changes and refused changes (ADR 0010) – always visible at the top. */
export function OfflineBar() {
  const status = useOfflineStatus()
  const pending = status.entries.filter((e) => e.status === 'pending')
  const failed = status.entries.filter((e) => e.status === 'failed')
  const offline = !status.online || status.usingCache
  if (!offline && !pending.length && !failed.length && !status.needsLogin) return null
  return (
    <section className="offline-bar" aria-live="polite" aria-label={t('off.title')}>
      {offline ? <p className="offline-state">{t('off.offline')}</p> : null}
      {status.needsLogin ? <p className="warning">{t('off.needsLogin')}</p> : null}
      {pending.length ? (
        <div className="offline-row">
          <span>
            {status.syncing ? t('off.syncing') : tf('off.pending', { n: String(pending.length) })}
          </span>
          <Button
            type="button"
            variant="ghost"
            width="natural"
            size="small"
            disabled={status.syncing}
            onClick={() => void syncNow()}
          >
            {t('off.syncNow')}
          </Button>
        </div>
      ) : null}
      {failed.length ? (
        <div className="offline-failed">
          <p className="warning">{tf('off.failed', { n: String(failed.length) })}</p>
          <ul className="list">
            {failed.map((entry) => (
              <li key={entry.seq} className="list-row">
                <span>
                  <strong>{entry.label}</strong>
                  <span className="block muted">{entry.error}</span>
                </span>
                <span className="actions">
                  <Button
                    type="button"
                    variant="ghost"
                    width="natural"
                    size="small"
                    onClick={() => void retryChange(entry.seq as number)}
                  >
                    {t('off.retry')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    width="natural"
                    size="small"
                    danger
                    onClick={() => {
                      if (window.confirm(t('off.discardConfirm')))
                        void discardChange(entry.seq as number)
                    }}
                  >
                    {t('off.discard')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
