import type { NotificationList, SearchHit, SearchResult } from '@opc/schemas'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import { type Navigate, pathOf, type Route } from '../router'

/** Where a search hit leads. Stammdaten have no own page yet: their list. */
function routeOf(hit: SearchHit): Route {
  switch (hit.kind) {
    case 'project':
      return { view: 'project', id: hit.id, section: 'overview' }
    case 'document':
      return { view: 'document', id: hit.id }
    case 'incoming':
      return { view: 'incomingInvoice', id: hit.id }
    case 'contact':
      return { view: 'contacts', id: hit.id }
    case 'catalog':
      return { view: 'catalog' }
  }
}

/** Globale Suche (P2.8): Projekte, Kontakte, Dokumente, Stammdaten, Eingangsrechnungen. */
export function SearchScreen({ q, navigate }: { q: string; navigate: Navigate }) {
  const id = useId()
  const [result, setResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (q.trim().length < 2) return
    api<SearchResult>('GET', `/api/v1/search?q=${encodeURIComponent(q)}`)
      .then(setResult)
      .catch((err: ApiError) => setError(err.message))
  }, [q])
  return (
    <section aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>{tf('search.title', { q })}</h1>
      {q.trim().length < 2 ? <p className="muted">{t('search.tooShort')}</p> : null}
      <FormError>{error}</FormError>
      {result && !result.groups.length ? <p className="muted">{t('search.none')}</p> : null}
      {result?.groups.map((group) => (
        <section key={group.kind} className="panel" aria-labelledby={`${id}-${group.kind}`}>
          <h2 id={`${id}-${group.kind}`}>{t(`search.kind.${group.kind}` as TextKey)}</h2>
          <ul className="list">
            {group.hits.map((hit) => (
              <li key={hit.id} className="list-link">
                <a
                  href={pathOf(routeOf(hit))}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate(routeOf(hit))
                  }}
                >
                  <strong>{hit.label}</strong>
                  {hit.detail ? <span className="muted">{hit.detail}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  )
}

/** Suchfeld in der Kopfzeile. */
export function SearchBox({ initial, navigate }: { initial: string; navigate: Navigate }) {
  const [q, setQ] = useState(initial)
  return (
    <search className="topbar-search">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (q.trim()) navigate({ view: 'search', q: q.trim() })
        }}
      >
        <input
          type="search"
          className="search"
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>
    </search>
  )
}

const POLL_MS = 5 * 60_000

/** Unread notifications; reloaded every five minutes while the app is open. */
export function useNotifications() {
  const [list, setList] = useState<NotificationList | null>(null)
  const reload = useCallback(() => {
    api<NotificationList>('GET', '/api/v1/notifications')
      .then(setList)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    reload()
    const timer = setInterval(reload, POLL_MS)
    return () => clearInterval(timer)
  }, [reload])
  return { list, setList, reload }
}

/** Benachrichtigungen (P2.8): opening one marks it as read. */
export function NotificationsScreen({
  list,
  setList,
  navigate,
}: {
  list: NotificationList | null
  setList: (list: NotificationList) => void
  navigate: (path: string) => void
}) {
  const id = useId()
  const [error, setError] = useState<string | null>(null)
  const run = (call: Promise<NotificationList>) =>
    call.then(setList).catch((err: ApiError) => setError(err.message))
  return (
    <section aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <h1 id={`${id}-title`}>{t('notif.title')}</h1>
        {list?.unreadCount ? (
          <button
            type="button"
            className="button ghost auto"
            onClick={() => run(api<NotificationList>('POST', '/api/v1/notifications/read-all', {}))}
          >
            {t('notif.readAll')}
          </button>
        ) : null}
      </div>
      <FormError>{error}</FormError>
      {!list ? <p className="muted">{t('common.loading')}</p> : null}
      {list && !list.items.length ? <p className="muted">{t('notif.none')}</p> : null}
      {list?.items.length ? (
        <ul className="list">
          {list.items.map((n) => (
            <li key={n.id} className={`list-link${n.read ? '' : ' unread'}`}>
              <a
                href={n.route}
                onClick={(e) => {
                  e.preventDefault()
                  if (!n.read) {
                    void run(
                      api<NotificationList>('POST', `/api/v1/notifications/${n.id}/read`, {}),
                    )
                  }
                  navigate(n.route)
                }}
              >
                <strong>
                  {n.read ? null : <span className="sr-only">{t('notif.unread')} </span>}
                  {n.title}
                </strong>
                <span className="muted">
                  {[n.body, formatDateTime(n.createdAt)].filter(Boolean).join(' · ')}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
