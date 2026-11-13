import type { CompanyNoticeEntry } from '@opc/schemas'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { type TextKey, t } from '../i18n'

/**
 * Hinweisleiste (P2.11, DESIGN.md §7.4): missing company data as a yellow bar with a direct link,
 * before it blocks finalizing an invoice. Reloaded when the view changes (cheap request).
 */
export function NoticeBar({
  reloadKey,
  open,
}: {
  reloadKey: string
  open: (path: string) => void
}) {
  const [notices, setNotices] = useState<CompanyNoticeEntry[]>([])
  useEffect(() => {
    if (!reloadKey) return
    api<CompanyNoticeEntry[]>('GET', '/api/v1/notices')
      .then(setNotices)
      // Offline or no session: no bar (the offline bar explains the state).
      .catch(() => setNotices([]))
  }, [reloadKey])
  if (!notices.length) return null
  return (
    <section className="notice-bar" aria-label={t('notice.title')}>
      <ul className="notice-list">
        {notices.map((notice) => (
          <li key={notice.key} className="notice-item">
            <span className="notice-text">
              {notice.severity === 'required' ? (
                <strong className="notice-required">{t('notice.required')}: </strong>
              ) : null}
              {t(`notice.${notice.key}` as TextKey) ?? notice.message}
            </span>
            <a
              href={notice.route}
              className="button ghost small"
              onClick={(event) => {
                event.preventDefault()
                open(notice.route)
              }}
            >
              {t('notice.fix')}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
