import type { ContactColor, ContactDetail, ContactSummary, Me, Page } from '@easybau/schemas'
import { Button } from '@easybau/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { api } from '../api'
import { Field, FormError, optional, useForm } from '../forms'
import { t, tf } from '../i18n'
import { hasWaitingChanges } from '../offline/client'
import { OfflineBar } from '../offline/OfflineBar'
import { type Navigate, parseRoute, type Route, useRoute } from '../router'
import { AuditScreen } from './audit'
import { Catalog } from './catalog'
import { ContactEditor } from './contact-editor'
import { ContactImport } from './contact-import'
import { Dashboard } from './dashboard'
import { DocumentScreen } from './document'
import { IncomingInvoiceScreen, IncomingInvoices } from './incoming'
import { Invoices } from './invoices'
import { MeasurementScreen } from './measurement'
import { NoticeBar } from './notice-bar'
import { PrintScreen } from './print'
import { ProjectScreen } from './project'
import { Projects } from './projects'
import { ReportScreen } from './report'
import { NotificationsScreen, SearchBox, SearchScreen, useNotifications } from './search'
import { Security } from './security'
import { Settings } from './settings'
import { Users } from './users'

type Tab =
  | 'dashboard'
  | 'projects'
  | 'invoices'
  | 'incoming'
  | 'contacts'
  | 'catalog'
  | 'audit'
  | 'users'
  | 'settings'
  | 'security'

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
  const notifications = useNotifications()
  const activeTab: Tab | null =
    current.view === 'search' || current.view === 'notifications'
      ? null
      : current.view === 'project' ||
          current.view === 'document' ||
          current.view === 'measurement' ||
          current.view === 'report' ||
          current.view === 'print'
        ? 'projects'
        : current.view === 'incomingInvoice'
          ? 'incoming'
          : current.view
  const tabs: { key: Tab; label: string; visible: boolean }[] = [
    { key: 'dashboard', label: t('nav.dashboard'), visible: !locked },
    { key: 'projects', label: t('nav.projects'), visible: !locked },
    {
      key: 'invoices',
      label: t('nav.invoices'),
      visible: !locked && me.permissions.includes('document.read'),
    },
    {
      key: 'incoming',
      label: t('nav.incoming'),
      visible: !locked && me.permissions.includes('incoming_invoice.read'),
    },
    {
      key: 'contacts',
      label: t('nav.contacts'),
      visible: !locked && me.permissions.includes('contacts.read'),
    },
    {
      key: 'catalog',
      label: t('nav.catalog'),
      visible: !locked && me.permissions.includes('catalog.read'),
    },
    {
      key: 'audit',
      label: t('nav.audit'),
      visible: !locked && me.permissions.includes('audit.read'),
    },
    {
      key: 'users',
      label: t('nav.users'),
      visible: !locked && me.permissions.includes('users.manage'),
    },
    {
      key: 'settings',
      label: t('nav.settings'),
      visible: !locked && me.permissions.includes('settings.read'),
    },
    { key: 'security', label: t('nav.security'), visible: true },
  ]
  const logout = async () => {
    if ((await hasWaitingChanges()) && !window.confirm(t('off.logoutWaiting'))) return
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
      : current.view === 'document' ||
          current.view === 'measurement' ||
          current.view === 'report' ||
          current.view === 'print' ||
          current.view === 'incomingInvoice'
        ? `${current.view}-${current.id}`
        : current.view === 'search'
          ? `search-${current.q}`
          : current.view
  const unread = notifications.list?.unreadCount ?? 0
  return (
    <div className="workspace">
      <header className="topbar">
        <strong>{me.tenant.name}</strong>
        <span className="muted">{me.user.displayName}</span>
        {locked ? null : (
          <>
            <SearchBox initial={current.view === 'search' ? current.q : ''} navigate={navigate} />
            <Button
              type="button"
              variant="ghost"
              width="natural"
              className="bell"
              aria-current={current.view === 'notifications' ? 'page' : undefined}
              onClick={() => {
                notifications.reload()
                navigate({ view: 'notifications' })
              }}
            >
              {t('notif.title')}
              {unread ? (
                <span className="badge-count">
                  {unread}
                  <span className="sr-only"> {t('notif.unreadShort')}</span>
                </span>
              ) : null}
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" width="natural" className="logout" onClick={logout}>
          {t('auth.logout')}
        </Button>
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
      <OfflineBar />
      <NoticeBar
        reloadKey={routeKey}
        open={(path) => {
          const [pathname, search] = path.split('?')
          navigate(parseRoute(pathname as string, search ? `?${search}` : ''))
        }}
      />
      <main className="content" key={`${routeKey}-${visit}`}>
        {current.view === 'dashboard' ? <Dashboard me={me} navigate={navigate} /> : null}
        {current.view === 'search' ? <SearchScreen q={current.q} navigate={navigate} /> : null}
        {current.view === 'notifications' ? (
          <NotificationsScreen
            list={notifications.list}
            setList={notifications.setList}
            navigate={(path) => navigate(parseRoute(path))}
          />
        ) : null}
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
        {current.view === 'print' ? <PrintScreen id={current.id} navigate={navigate} /> : null}
        {current.view === 'report' ? (
          <ReportScreen me={me} id={current.id} navigate={navigate} />
        ) : null}
        {current.view === 'catalog' ? <Catalog me={me} itemId={current.id} /> : null}
        {current.view === 'settings' ? <Settings me={me} initial={current.section} /> : null}
        {current.view === 'contacts' ? (
          <Contacts me={me} navigate={navigate} selected={current.id ?? null} />
        ) : null}
        {current.view === 'invoices' ? <Invoices me={me} navigate={navigate} /> : null}
        {current.view === 'incoming' ? <IncomingInvoices me={me} navigate={navigate} /> : null}
        {current.view === 'incomingInvoice' ? (
          <IncomingInvoiceScreen id={current.id} navigate={navigate} />
        ) : null}
        {current.view === 'users' ? <Users /> : null}
        {current.view === 'audit' ? <AuditScreen me={me} /> : null}
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

const NO_CONTACT_FILTER = { kind: '', customer: '', color: '', archived: false }

function contactQuery(query: string, filter: typeof NO_CONTACT_FILTER) {
  const params = new URLSearchParams({ q: query })
  if (filter.kind) params.set('kind', filter.kind)
  if (filter.customer) params.set('customer', filter.customer)
  if (filter.color) params.set('color', filter.color)
  if (filter.archived) params.set('archived', 'true')
  return params.toString()
}

/** Kontakte; the open contact has its own URL (/kontakte/<id>), e.g. for search hits and links. */
function Contacts({
  me,
  navigate,
  selected,
}: {
  me: Me
  navigate: Navigate
  selected: string | null
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState(NO_CONTACT_FILTER)
  const [importing, setImporting] = useState(false)
  const filterId = useId()
  const list = useList<ContactSummary>(`/api/v1/contacts?${contactQuery(query, filter)}`)
  const [colors, setColors] = useState<ContactColor[]>([])
  useEffect(() => {
    api<ContactColor[]>('GET', '/api/v1/contacts/colors')
      .then(setColors)
      .catch(() => undefined)
  }, [])
  const canWrite = me.permissions.includes('contacts.write')
  const [kind, setKind] = useState<'organization' | 'person'>('organization')
  const setSelected = (id: string | null) =>
    navigate(id ? { view: 'contacts', id } : { view: 'contacts' })
  const form = useForm(
    (data) =>
      api<ContactDetail>('POST', '/api/v1/contacts', {
        kind,
        organizationName: optional(data, 'organizationName'),
        firstName: optional(data, 'firstName'),
        lastName: optional(data, 'lastName'),
      }),
    (created) => {
      list.reload()
      // Continue with address and e-invoice data of the new contact.
      setSelected(created.id)
    },
  )
  return (
    <section aria-labelledby="contacts-title">
      <div className="section-head">
        <h1 id="contacts-title">{t('nav.contacts')}</h1>
        <div className="button-row">
          <a
            className="button ghost auto"
            href={`/api/v1/contacts/export.csv?${contactQuery('', filter)}`}
            download
          >
            {t('contacts.export')}
          </a>
          {canWrite && !importing ? (
            <Button type="button" variant="ghost" onClick={() => setImporting(true)}>
              {t('contacts.import.title')}
            </Button>
          ) : null}
        </div>
      </div>
      {importing ? (
        <ContactImport onImported={list.reload} onClose={() => setImporting(false)} />
      ) : null}
      <input
        type="search"
        className="search"
        aria-label={t('common.search')}
        placeholder={t('common.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="row contact-filters">
        <div className="field">
          <label htmlFor={`${filterId}-kind`}>{t('contacts.filter.kind')}</label>
          <select
            id={`${filterId}-kind`}
            className="select"
            value={filter.kind}
            onChange={(e) => setFilter({ ...filter, kind: e.target.value })}
          >
            <option value="">{t('contacts.filter.all')}</option>
            <option value="organization">{t('contacts.kind.organization')}</option>
            <option value="person">{t('contacts.kind.person')}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${filterId}-customer`}>{t('contacts.filter.customer')}</label>
          <select
            id={`${filterId}-customer`}
            className="select"
            value={filter.customer}
            onChange={(e) => setFilter({ ...filter, customer: e.target.value })}
          >
            <option value="">{t('contacts.filter.all')}</option>
            <option value="true">{t('contacts.filter.customers')}</option>
            <option value="false">{t('contacts.filter.others')}</option>
          </select>
        </div>
      </div>
      {colors.length ? (
        <fieldset className="plain color-filter">
          <legend>{t('contacts.filter.color')}</legend>
          <label className="color-swatch-option">
            <input
              type="radio"
              name={`${filterId}-color`}
              checked={!filter.color}
              onChange={() => setFilter({ ...filter, color: '' })}
            />
            <span>{t('contacts.filter.all')}</span>
          </label>
          {colors.map((c) => (
            <label key={c.color} className="color-swatch-option">
              <input
                type="radio"
                name={`${filterId}-color`}
                checked={filter.color === c.color}
                onChange={() => setFilter({ ...filter, color: c.color })}
              />
              <span className="color-swatch" style={{ background: c.color }} aria-hidden="true" />
              <span className="visually-hidden">
                {tf('contacts.filter.colorOption', { color: c.color })}
              </span>
              <span className="muted">{c.count}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="check">
        <input
          type="checkbox"
          checked={filter.archived}
          onChange={(e) => setFilter({ ...filter, archived: e.target.checked })}
        />
        <span>{t('contacts.filter.archived')}</span>
      </label>
      {canWrite ? (
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
          <Button type="submit" variant="primary" width="natural" disabled={form.busy}>
            {t('common.save')}
          </Button>
        </form>
      ) : null}
      {selected ? (
        <ContactEditor
          id={selected}
          canWrite={canWrite}
          canReadSettings={me.permissions.includes('settings.read')}
          onSaved={() => list.reload()}
          onClose={() => setSelected(null)}
          onOpenProject={(projectId) =>
            navigate({ view: 'project', id: projectId, section: 'overview' })
          }
          onOpenContact={(contactId) => setSelected(contactId)}
        />
      ) : null}
      <List
        items={list.items}
        error={list.error}
        render={(c) => (
          <button
            type="button"
            className="list-button"
            aria-current={selected === c.id ? 'true' : undefined}
            onClick={() => setSelected(c.id)}
          >
            <strong>{c.displayName}</strong>
            <span className="muted">
              {[c.number, c.city, c.primaryEmail].filter(Boolean).join(' · ')}
            </span>
          </button>
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
