import type {
  ContactDetail,
  ContactSummary,
  Me,
  Page,
  ProjectDetail,
  ProjectStatus,
  ProjectSummary,
} from '@opc/schemas'
import { useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { Field, FormError, optional, SelectField, TextArea, useForm, value } from '../forms'
import { t } from '../i18n'
import type { Navigate } from '../router'

export function useStatuses() {
  const [statuses, setStatuses] = useState<ProjectStatus[]>([])
  useEffect(() => {
    api<ProjectStatus[]>('GET', '/api/v1/project-statuses')
      .then(setStatuses)
      .catch(() => undefined)
  }, [])
  return statuses
}

/** Project list with search and the form for a new project. */
export function Projects({ me, navigate }: { me: Me; navigate: Navigate }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      api<Page<ProjectSummary>>('GET', `/api/v1/projects?q=${encodeURIComponent(query)}`)
        .then((page) => setItems(page.items))
        .catch((err: ApiError) => setError(err.message))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  return (
    <section aria-labelledby="projects-title">
      <div className="section-head">
        <h1 id="projects-title">{t('nav.projects')}</h1>
        {me.permissions.includes('project.write') && !creating ? (
          <button type="button" className="button primary auto" onClick={() => setCreating(true)}>
            {t('projects.new')}
          </button>
        ) : null}
      </div>
      {creating ? (
        <ProjectForm
          onCancel={() => setCreating(false)}
          onSaved={(project) => navigate({ view: 'project', id: project.id, section: 'overview' })}
        />
      ) : null}
      <input
        type="search"
        className="search"
        aria-label={t('projects.search')}
        placeholder={t('projects.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <FormError>{error}</FormError>
      {!items ? <p className="muted">{t('common.loading')}</p> : null}
      {items && !items.length ? <p className="muted">{t('common.empty')}</p> : null}
      {items?.length ? (
        <ul className="list">
          {items.map((p) => (
            <li key={p.id} className="list-link">
              <a
                href={`/projekte/${p.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  navigate({ view: 'project', id: p.id, section: 'overview' })
                }}
              >
                <strong>
                  {p.number ? `${p.number} · ` : ''}
                  {p.name}
                </strong>
                <span className="muted">
                  {[p.customer?.displayName, p.siteCity, period(p.startDate, p.endDate)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {p.status ? <StatusBadge status={p.status} /> : null}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

export function period(start: string | null, end: string | null): string {
  if (!start && !end) return ''
  return `${formatDateTime(start, 'date') || '…'} – ${formatDateTime(end, 'date') || '…'}`
}

export function StatusBadge({ status }: { status: { label: string; color: string | null } }) {
  return (
    <span className="status" style={status.color ? { borderColor: status.color } : undefined}>
      <span
        className="status-dot"
        style={status.color ? { background: status.color } : undefined}
        aria-hidden="true"
      />
      {status.label}
    </span>
  )
}

/** Create or edit a project (DESIGN.md §2 Projekte). */
export function ProjectForm({
  project,
  onSaved,
  onCancel,
}: {
  project?: ProjectDetail & { etag?: string | null }
  onSaved: (project: ProjectDetail) => void
  onCancel: () => void
}) {
  const statuses = useStatuses()
  const [customers, setCustomers] = useState<ContactSummary[]>([])
  const [customerId, setCustomerId] = useState(project?.customer?.id ?? '')
  const [site, setSite] = useState({
    street: project?.site.street ?? '',
    postalCode: project?.site.postalCode ?? '',
    city: project?.site.city ?? '',
  })
  const [addressError, setAddressError] = useState<string | null>(null)

  useEffect(() => {
    api<Page<ContactSummary>>('GET', '/api/v1/contacts?limit=100')
      .then((page) => setCustomers(page.items))
      .catch(() => undefined)
  }, [])

  const takeCustomerAddress = async () => {
    setAddressError(null)
    try {
      const contact = await api<ContactDetail>('GET', `/api/v1/contacts/${customerId}`)
      const address = contact.addresses.find((a) => a.kind === 'main') ?? contact.addresses[0]
      if (!address) {
        setAddressError(t('common.empty'))
        return
      }
      setSite({
        street: address.street ?? '',
        postalCode: address.postalCode ?? '',
        city: address.city ?? '',
      })
    } catch (err) {
      setAddressError((err as ApiError).message)
    }
  }

  const form = useForm(async (data) => {
    const body = {
      name: value(data, 'name'),
      number: optional(data, 'number'),
      description: optional(data, 'description'),
      statusId: optional(data, 'statusId') ?? null,
      customerId: customerId || null,
      startDate: optional(data, 'startDate') ?? null,
      endDate: optional(data, 'endDate') ?? null,
      site: {
        street: site.street,
        postalCode: site.postalCode,
        city: site.city,
        countryCode: 'DE',
      },
    }
    if (!project) return api<ProjectDetail>('POST', '/api/v1/projects', body)
    return api<ProjectDetail>('PATCH', `/api/v1/projects/${project.id}`, body)
  }, onSaved)

  return (
    <form className="panel" onSubmit={form.onSubmit} noValidate>
      <h2>{project ? t('common.edit') : t('projects.new')}</h2>
      <FormError>{form.error}</FormError>
      <Field
        label={t('projects.name')}
        name="name"
        required
        defaultValue={project?.name}
        error={form.fieldErrors.name}
      />
      <SelectField
        label={t('projects.customer')}
        name="customerId"
        value={customerId}
        onChange={setCustomerId}
        options={[
          { value: '', label: t('projects.noCustomer') },
          ...customers.map((c) => ({ value: c.id, label: c.displayName })),
          ...(project?.customer && !customers.some((c) => c.id === project.customer?.id)
            ? [{ value: project.customer.id, label: project.customer.displayName }]
            : []),
        ]}
        error={form.fieldErrors.customerId}
      />
      <fieldset>
        <legend>{t('projects.site')}</legend>
        {customerId ? (
          <button type="button" className="button ghost small" onClick={takeCustomerAddress}>
            {t('projects.useCustomerAddress')}
          </button>
        ) : null}
        <FormError>{addressError}</FormError>
        <div className="field">
          <label htmlFor="site-street">{t('projects.street')}</label>
          <input
            id="site-street"
            autoComplete="street-address"
            value={site.street}
            onChange={(e) => setSite({ ...site, street: e.target.value })}
          />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="site-zip">{t('projects.postalCode')}</label>
            <input
              id="site-zip"
              inputMode="numeric"
              autoComplete="postal-code"
              value={site.postalCode}
              onChange={(e) => setSite({ ...site, postalCode: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="site-city">{t('projects.siteCity')}</label>
            <input
              id="site-city"
              autoComplete="address-level2"
              value={site.city}
              onChange={(e) => setSite({ ...site, city: e.target.value })}
            />
          </div>
        </div>
      </fieldset>
      <div className="row">
        <Field
          label={t('projects.start')}
          name="startDate"
          type="date"
          defaultValue={project?.startDate ?? undefined}
          error={form.fieldErrors.startDate}
        />
        <Field
          label={t('projects.end')}
          name="endDate"
          type="date"
          defaultValue={project?.endDate ?? undefined}
          error={form.fieldErrors.endDate}
        />
      </div>
      <details className="more" open={Boolean(project)}>
        <summary>{t('projects.more')}</summary>
        {statuses.length ? (
          <SelectField
            label={t('projects.status')}
            name="statusId"
            defaultValue={project?.status?.id ?? statuses[0]?.id}
            options={[
              { value: '', label: t('projects.noStatus') },
              ...statuses.map((s) => ({ value: s.id, label: s.label })),
            ]}
          />
        ) : null}
        <Field
          label={t('projects.number')}
          name="number"
          hint={project ? undefined : t('projects.numberHint')}
          defaultValue={project?.number ?? undefined}
          error={form.fieldErrors.number}
        />
        <TextArea
          label={t('projects.description')}
          name="description"
          defaultValue={project?.description}
          error={form.fieldErrors.description}
        />
      </details>
      <div className="button-row">
        <button type="submit" className="button primary auto" disabled={form.busy}>
          {project ? t('common.save') : t('projects.create')}
        </button>
        <button type="button" className="button ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}
