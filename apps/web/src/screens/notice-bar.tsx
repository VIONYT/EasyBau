import type { CompanyNoticeEntry } from '@easybau/schemas'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { type TextKey, t, tn } from '../i18n'

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
  // Open/closed is a per-tab convenience only (no state that must persist).
  const [expanded, setExpanded] = useState(storedOpen)
  const remember = (open: boolean) => {
    setExpanded(open)
    try {
      sessionStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      // private mode: just not remembered
    }
  }
  useEffect(() => {
    if (!reloadKey) return
    api<CompanyNoticeEntry[]>('GET', '/api/v1/notices')
      .then(setNotices)
      // Offline or no session: no bar (the offline bar explains the state).
      .catch(() => setNotices([]))
  }, [reloadKey])
  if (!notices.length) return null
  const list = (
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
            className="notice-fix"
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
  )
  // Progressive disclosure: a few notices stay visible, a longer list folds into one line
  // so the screen's own content stays on the first screen (phones on site).
  if (notices.length <= 2) {
    return (
      <section className="notice-bar" aria-label={t('notice.title')}>
        {list}
      </section>
    )
  }
  const required = notices.filter((n) => n.severity === 'required').length
  return (
    <section className="notice-bar" aria-label={t('notice.title')}>
      <details open={expanded} onToggle={(e) => remember(e.currentTarget.open)}>
        <summary className="notice-summary">
          {tn('notice.summary', notices.length)}
          {required ? (
            <span className="notice-required"> · {tn('notice.summaryRequired', required)}</span>
          ) : null}
        </summary>
        {list}
      </details>
    </section>
  )
}

const OPEN_KEY = 'easybau.notices.open'

function storedOpen(): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}
