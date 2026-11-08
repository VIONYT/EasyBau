import type { ContactDetail, ContactSummary, Me, Page } from '@opc/schemas'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Field, FormError, optional, useForm } from '../forms'
import { t } from '../i18n'
import { type Route, useRoute } from '../router'
import { DocumentScreen } from './document'
import { MeasurementScreen } from './measurement'
import { ProjectScreen } from './project'
import { Projects } from './projects'
import { Security } from './security'
import { Users } from './users'

type Tab = 'projects' | 'contacts' | 'users' | 'security'

/** Working area after login. Admins without second factor only see the security settings. */
export function Workspace({
  me,
  onLogout,
  onMeChanged,
}: {
  me: Me
  onLogout: () => void
  onMeChanged: (me: Me) => void
}) {
  const locked = me.twoFactorSetupRequired
  const [route, navigate] = useRoute()
  // Clicking a tab (again) re-mounts it, so its data is fresh.
  const [visit, setVisit] = useState(0)
  // While the second factor is missing, stay on (and show the URL of) the security settings,
  // so the person continues there after enrolling a key.
  useEffect(() => {
    if (locked && route.view !== 'security') navigate({ view: 'security' })
  }, [locked, route.view, navigate])
  const current: Route = locked ? { view: 'security' } : route
  const activeTab: Tab =
    current.view === 'project' || current.view === 'document' || current.view === 'measurement'
      ? 'projects'
      : current.view
  const tabs: { key: Tab; label: string; visible: boolean }[] = [
    { key: 'projects', label: t('nav.projects'), visible: !locked },
    {
      key: 'contacts',
      label: t('nav.contacts'),
      visible: !locked && me.permissions.includes('contacts.read'),
    },
    {
      key: 'users',
      label: t('nav.users'),
      visible: !locked && me.permissions.includes('users.manage'),
    },
    { key: 'security', label: t('nav.security'), visible: true },
  ]
  const logout = async () => {
    await api('POST', '/api/v1/auth/logout').catch(() => undefined)
    window.history.replaceState(null, '', '/')
    onLogout()
  }
  const refreshMe = () => {
    api<Me>('GET', '/api/v1/auth/me')
      .then(onMeChanged)
      .catch(() => undefined)
  }
  const routeKey =
    current.view === 'project'
      ? `project-${current.id}`
      : current.view === 'document' || current.view === 'measurement'
        ? `${current.view}-${current.id}`
        : current.view
  return (
    <div className="workspace">
      <header className="topbar">
        <strong>{me.tenant.name}</strong>
        <span className="muted">{me.user.displayName}</span>
        <button type="button" className="button ghost" onClick={logout}>
          {t('auth.logout')}
        </button>
      </header>
      <nav className="tabs" aria-label="Bereiche">
        {tabs
          .filter((item) => item.visible)
          .map((item) => (
            <button
              key={item.key}
              type="button"
              aria-current={activeTab === item.key ? 'page' : undefined}
              onClick={() => {
                navigate({ view: item.key })
                setVisit((v) => v + 1)
              }}
            >
              {item.label}
            </button>
          ))}
      </nav>
      <main className="content" key={`${routeKey}-${visit}`}>
        {current.view === 'projects' ? <Projects me={me} navigate={navigate} /> : null}
        {current.view === 'project' ? (
          <ProjectScreen me={me} id={current.id} section={current.section} navigate={navigate} />
        ) : null}
        {current.view === 'document' ? (
          <DocumentScreen me={me} id={current.id} navigate={navigate} />
        ) : null}
        {current.view === 'measurement' ? (
          <MeasurementScreen me={me} id={current.id} navigate={navigate} />
        ) : null}
        {current.view === 'contacts' ? <Contacts me={me} /> : null}
        {current.view === 'users' ? <Users /> : null}
        {current.view === 'security' ? <Security me={me} onChanged={refreshMe} /> : null}
      </main>
    </div>
  )
}

function useList<T>(path: string) {
  const [items, setItems] = useState<T[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api<Page<T>>('GET', path)
      .then((page) => setItems(page.items))
      .catch((err: Error) => setError(err.message))
  }, [path])
  useEffect(reload, [reload])
  return { items, error, reload }
}

function Contacts({ me }: { me: Me }) {
  const [query, setQuery] = useState('')
  const list = useList<ContactSummary>(`/api/v1/contacts?q=${encodeURIComponent(query)}`)
  const [kind, setKind] = useState<'organization' | 'person'>('organization')
  const form = useForm(
    (data) =>
      api<ContactDetail>('POST', '/api/v1/contacts', {
        kind,
        organizationName: optional(data, 'organizationName'),
        firstName: optional(data, 'firstName'),
        lastName: optional(data, 'lastName'),
      }),
    () => list.reload(),
  )
  return (
    <section aria-labelledby="contacts-title">
      <h1 id="contacts-title">{t('nav.contacts')}</h1>
      <input
        type="search"
        className="search"
        aria-label={t('common.search')}
        placeholder={t('common.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {me.permissions.includes('contacts.write') ? (
        <form className="inline-form" onSubmit={form.onSubmit} noValidate>
          <h2>{t('contacts.new')}</h2>
          <FormError>{form.error}</FormError>
          <fieldset className="segmented">
            <legend className="visually-hidden">{t('contacts.kind')}</legend>
            {(['organization', 'person'] as const).map((k) => (
              <label key={k}>
                <input
                  type="radio"
                  name="kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                <span>{t(`contacts.kind.${k}`)}</span>
              </label>
            ))}
          </fieldset>
          {kind === 'organization' ? (
            <Field
              label={t('contacts.organizationName')}
              name="organizationName"
              required
              error={form.fieldErrors.organizationName}
            />
          ) : (
            <div className="row">
              <Field
                label={t('contacts.firstName')}
                name="firstName"
                error={form.fieldErrors.firstName}
              />
              <Field
                label={t('contacts.lastName')}
                name="lastName"
                error={form.fieldErrors.lastName}
              />
            </div>
          )}
          <button type="submit" className="button primary" disabled={form.busy}>
            {t('common.save')}
          </button>
        </form>
      ) : null}
      <List
        items={list.items}
        error={list.error}
        render={(c) => (
          <>
            <strong>{c.displayName}</strong>
            <span className="muted">
              {[c.number, c.city, c.primaryEmail].filter(Boolean).join(' · ')}
            </span>
          </>
        )}
      />
    </section>
  )
}

function List<T extends { id: string }>({
  items,
  error,
  render,
}: {
  items: T[] | null
  error: string | null
  render: (item: T) => React.ReactNode
}) {
  if (error) return <FormError>{error}</FormError>
  if (!items) return <p className="muted">{t('common.loading')}</p>
  if (!items.length) return <p className="muted">{t('common.empty')}</p>
  return (
    <ul className="list">
      {items.map((item) => (
        <li key={item.id}>{render(item)}</li>
      ))}
    </ul>
  )
}
