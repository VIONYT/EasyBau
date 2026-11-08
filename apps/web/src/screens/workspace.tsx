import type {
  ContactDetail,
  ContactSummary,
  Me,
  Page,
  ProjectDetail,
  ProjectSummary,
} from '@opc/schemas'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Field, FormError, optional, useForm, value } from '../forms'
import { t } from '../i18n'

type Tab = 'projects' | 'contacts'

/** First working area after login: projects and contacts. Detail views follow with the router. */
export function Workspace({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('projects')
  const canContacts = me.permissions.includes('contacts.read')
  const logout = async () => {
    await api('POST', '/api/v1/auth/logout').catch(() => undefined)
    onLogout()
  }
  return (
    <div className="workspace">
      <header className="topbar">
        <strong>{me.tenant.name}</strong>
        <span className="muted">{me.user.displayName}</span>
        <button type="button" className="button ghost" onClick={logout}>
          {t('auth.logout')}
        </button>
      </header>
      {me.twoFactorSetupRequired ? (
        <p className="notice" role="status">
          {t('auth.twoFactorRequired')}
        </p>
      ) : null}
      <nav className="tabs" aria-label="Bereiche">
        <button
          type="button"
          aria-current={tab === 'projects' ? 'page' : undefined}
          onClick={() => setTab('projects')}
        >
          {t('nav.projects')}
        </button>
        {canContacts ? (
          <button
            type="button"
            aria-current={tab === 'contacts' ? 'page' : undefined}
            onClick={() => setTab('contacts')}
          >
            {t('nav.contacts')}
          </button>
        ) : null}
      </nav>
      <main className="content">
        {tab === 'projects' ? <Projects me={me} /> : <Contacts me={me} />}
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

function Projects({ me }: { me: Me }) {
  const list = useList<ProjectSummary>('/api/v1/projects')
  const form = useForm(
    (data) =>
      api<ProjectDetail>('POST', '/api/v1/projects', {
        name: value(data, 'name'),
        site: { city: optional(data, 'city') },
      }),
    () => list.reload(),
  )
  return (
    <section aria-labelledby="projects-title">
      <h1 id="projects-title">{t('nav.projects')}</h1>
      {me.permissions.includes('project.write') ? (
        <form className="inline-form" onSubmit={form.onSubmit} noValidate>
          <h2>{t('projects.new')}</h2>
          <FormError>{form.error}</FormError>
          <Field label={t('projects.name')} name="name" required error={form.fieldErrors.name} />
          <Field label={t('projects.city')} name="city" error={form.fieldErrors['site.city']} />
          <button type="submit" className="button primary" disabled={form.busy}>
            {t('common.save')}
          </button>
        </form>
      ) : null}
      <List
        items={list.items}
        error={list.error}
        render={(p) => (
          <>
            <strong>
              {p.number ? `${p.number} · ` : ''}
              {p.name}
            </strong>
            <span className="muted">
              {[p.status?.label, p.customer?.displayName, p.siteCity].filter(Boolean).join(' · ')}
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
