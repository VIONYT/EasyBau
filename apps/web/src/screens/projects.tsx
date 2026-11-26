import type {
  ContactDetail,
  ContactSummary,
  Me,
  Page,
  ProjectDetail,
  ProjectFigureColumns,
  ProjectStatus,
  ProjectSummary,
  TeamMember,
} from '@easybau/schemas'
import { Button } from '@easybau/ui'
import { useEffect, useId, useState } from 'react'
import { type ApiError, api, apiWithEtag } from '../api'
import { formatCents, formatDateTime } from '../format'
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

const NO_FILTER = { statusId: '', memberId: '', from: '', to: '', archived: false }
type Filter = typeof NO_FILTER

/** Query of the project list; without filters exactly `?q=…` (kept for offline use, ADR 0010). */
export function projectListPath(query: string, filter: Filter): string {
  const params = new URLSearchParams({ q: query })
  for (const key of ['statusId', 'memberId', 'from', 'to'] as const) {
    if (filter[key]) params.set(key, filter[key])
  }
  if (filter.archived) params.set('archived', 'true')
  return `/api/v1/projects?${params.toString()}`
}

/** Filters and search from the address (/projekte?status=…), so a filtered list can be bookmarked. */
function filterFromUrl(): { query: string; filter: Filter } {
  const params = new URLSearchParams(window.location.search)
  return {
    query: params.get('q') ?? '',
    filter: {
      statusId: params.get('statusId') ?? '',
      memberId: params.get('memberId') ?? '',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
      archived: params.get('archived') === 'true',
    },
  }
}

function filterToUrl(query: string, filter: Filter) {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  for (const key of ['statusId', 'memberId', 'from', 'to'] as const) {
    if (filter[key]) params.set(key, filter[key])
  }
  if (filter.archived) params.set('archived', 'true')
  const search = params.toString()
  const url = `${window.location.pathname}${search ? `?${search}` : ''}`
  if (url !== `${window.location.pathname}${window.location.search}`) {
    window.history.replaceState(window.history.state, '', url)
  }
}

/** Project list with search, filters (Status, Mitarbeitende, Zeitraum, archiviert) and the form for a new project. */
export function Projects({ me, navigate }: { me: Me; navigate: Navigate }) {
  const [initial] = useState(filterFromUrl)
  const [query, setQuery] = useState(initial.query)
  const [filter, setFilter] = useState<Filter>(initial.filter)
  // Kennzahlen as columns (on request: they are computed per project like in the overview).
  const canFigures = me.permissions.includes('document.read')
  const [showFigures, setShowFigures] = useState(false)
  const [figures, setFigures] = useState<Record<string, ProjectFigureColumns>>({})
  const canWrite = me.permissions.includes('project.write')
  const [items, setItems] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const statuses = useStatuses()
  const [team, setTeam] = useState<TeamMember[]>([])
  const filterId = useId()

  useEffect(() => {
    api<TeamMember[]>('GET', '/api/v1/team')
      .then(setTeam)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      setError(null)
      api<Page<ProjectSummary>>('GET', projectListPath(query, filter))
        .then((page) => setItems(page.items))
        .catch((err: ApiError) => setError(err.message))
      filterToUrl(query, filter)
    }, 200)
    return () => clearTimeout(timer)
  }, [query, filter])
  useEffect(() => {
    if (!showFigures || !items?.length) return
    const ids = items
      .slice(0, 30)
      .map((p) => p.id)
      .join(',')
    api<Record<string, ProjectFigureColumns>>('GET', `/api/v1/projects/figures?ids=${ids}`)
      .then(setFigures)
      .catch(() => setFigures({}))
  }, [showFigures, items])
  const set = (patch: Partial<Filter>) => setFilter({ ...filter, ...patch })
  const active = Object.entries(filter).filter(([, v]) => v).length

  return (
    <section aria-labelledby="projects-title">
      <div className="section-head">
        <h1 id="projects-title">{t('nav.projects')}</h1>
        {me.permissions.includes('project.write') && !creating ? (
          <Button type="button" variant="primary" onClick={() => setCreating(true)}>
            {t('projects.new')}
          </Button>
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
      <details className="panel filters" open={active > 0 || undefined}>
        <summary>
          {t('projects.filter.title')}
          {active ? ` (${active})` : ''}
        </summary>
        <div className="row">
          <div className="field">
            <label htmlFor={`${filterId}-status`}>{t('projects.filter.status')}</label>
            <select
              id={`${filterId}-status`}
              value={filter.statusId}
              onChange={(e) => set({ statusId: e.target.value })}
            >
              <option value="">{t('projects.filter.allStatuses')}</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${filterId}-member`}>{t('projects.filter.member')}</label>
            <select
              id={`${filterId}-member`}
              value={filter.memberId}
              onChange={(e) => set({ memberId: e.target.value })}
            >
              <option value="">{t('projects.filter.allMembers')}</option>
              <option value={me.user.id}>{t('projects.filter.mine')}</option>
              {team
                .filter((p) => p.id !== me.user.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${filterId}-from`}>{t('projects.filter.from')}</label>
            <input
              id={`${filterId}-from`}
              type="date"
              value={filter.from}
              onChange={(e) => set({ from: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`${filterId}-to`}>{t('projects.filter.to')}</label>
            <input
              id={`${filterId}-to`}
              type="date"
              value={filter.to}
              onChange={(e) => set({ to: e.target.value })}
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={filter.archived}
            onChange={(e) => set({ archived: e.target.checked })}
          />
          <span>{t('projects.filter.archived')}</span>
        </label>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            width="natural"
            size="small"
            onClick={() => setFilter(NO_FILTER)}
          >
            {t('projects.filter.reset')}
          </Button>
        ) : null}
      </details>
      {canFigures ? (
        <label className="check">
          <input
            type="checkbox"
            checked={showFigures}
            onChange={(e) => setShowFigures(e.target.checked)}
          />
          <span>{t('projects.showFigures')}</span>
        </label>
      ) : null}
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
                {p.status && !canWrite ? <StatusBadge status={p.status} /> : null}
                {showFigures && figures[p.id] ? (
                  <span className="project-figures-line">
                    <FigureColumns figures={figures[p.id] as ProjectFigureColumns} />
                  </span>
                ) : null}
              </a>
              {canWrite ? (
                <ProjectStatusSelect
                  project={p}
                  statuses={statuses}
                  onChanged={(status) =>
                    setItems(
                      (all) => all?.map((x) => (x.id === p.id ? { ...x, status } : x)) ?? null,
                    )
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function FigureColumns({ figures }: { figures: ProjectFigureColumns }) {
  const parts = [
    figures.contractNetCents !== null
      ? `${t('projects.fig.contract')} ${formatCents(figures.contractNetCents)}`
      : null,
    `${t('projects.fig.billed')} ${formatCents(figures.billedNetCents)}${
      figures.billedPercent ? ` (${figures.billedPercent} %)` : ''
    }`,
    figures.openReceivableCents
      ? `${t('projects.fig.open')} ${formatCents(figures.openReceivableCents)}`
      : null,
  ]
  return <span className="muted tabular">{parts.filter(Boolean).join(' · ')}</span>
}

/** Projektstatus direkt ändern (Liste, Übersicht). */
export function ProjectStatusSelect({
  project,
  statuses,
  onChanged,
}: {
  project: Pick<ProjectSummary, 'id' | 'name' | 'status'>
  statuses: ProjectStatus[]
  onChanged: (status: ProjectSummary['status']) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!statuses.length) return project.status ? <StatusBadge status={project.status} /> : null
  return (
    <span className="status-select">
      <select
        className="select small"
        aria-label={`${t('projects.status')}: ${project.name}`}
        value={project.status?.id ?? ''}
        disabled={busy}
        onChange={async (e) => {
          const statusId = e.target.value || null
          setBusy(true)
          setError(null)
          try {
            const current = await apiWithEtag<ProjectDetail>(
              'GET',
              `/api/v1/projects/${project.id}`,
            )
            const saved = await apiWithEtag<ProjectDetail>(
              'PATCH',
              `/api/v1/projects/${project.id}`,
              { statusId },
              current.etag,
            )
            onChanged(saved.data.status)
          } catch (err) {
            setError((err as ApiError).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <option value="">{t('common.none')}</option>
        {statuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {error ? <span className="error">{error}</span> : null}
    </span>
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
          <Button
            type="button"
            variant="ghost"
            width="natural"
            size="small"
            onClick={takeCustomerAddress}
          >
            {t('projects.useCustomerAddress')}
          </Button>
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
        <Button type="submit" variant="primary" disabled={form.busy}>
          {project ? t('common.save') : t('projects.create')}
        </Button>
        <Button type="button" variant="ghost" width="natural" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
