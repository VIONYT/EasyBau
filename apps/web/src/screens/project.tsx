import type { Me, ProjectDetail } from '@easybau/schemas'
import { useCallback, useEffect, useState } from 'react'
import { type ApiError, apiWithEtag } from '../api'
import { FormError } from '../forms'
import { t, tf } from '../i18n'
import { prepareProjectOffline } from '../offline/prefetch'
import type { Navigate, ProjectSection } from '../router'
import { ContractPanel } from './contract'
import { ProjectDiary, ProjectReports } from './diary'
import { ProjectDocuments } from './documents'
import { ProjectFiles } from './files'
import { ProjectMeasurements } from './measurements'
import { ProjectFiguresPanel } from './project-figures'
import { ProjectForm, period, StatusBadge, useStatuses } from './projects'

type Section = ProjectSection

/** Projekt-Detail (DESIGN.md §7.3): header, key facts, Dokumente and Ablage. */
export function ProjectScreen({
  me,
  id,
  section,
  navigate,
}: {
  me: Me
  id: string
  section: Section
  navigate: Navigate
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const statuses = useStatuses()
  const canWrite = me.permissions.includes('project.write')
  const siteWork =
    me.permissions.includes('measurement.write') || me.permissions.includes('report.write')
  const [offline, setOffline] = useState<string | null>(null)
  const prepare = async () => {
    setOffline(t('off.preparing'))
    try {
      const n = await prepareProjectOffline(id)
      setOffline(tf('off.prepared', { n: String(n) }))
    } catch (err) {
      setOffline((err as Error).message)
    }
  }

  const load = useCallback(() => {
    apiWithEtag<ProjectDetail>('GET', `/api/v1/projects/${id}`)
      .then(({ data, etag: tag }) => {
        setProject(data)
        setEtag(tag)
      })
      .catch((err: ApiError) => setError(err.message))
  }, [id])
  useEffect(load, [load])

  const changeStatus = async (statusId: string) => {
    setError(null)
    try {
      const res = await apiWithEtag<ProjectDetail>(
        'PATCH',
        `/api/v1/projects/${id}`,
        { statusId: statusId || null },
        etag,
      )
      setProject(res.data)
      setEtag(res.etag)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  if (error && !project) return <FormError>{error}</FormError>
  if (!project) return <p className="muted">{t('common.loading')}</p>

  const sections: { key: Section; label: string; visible: boolean }[] = [
    { key: 'overview', label: t('projects.overview'), visible: true },
    {
      key: 'documents',
      label: t('documents.title'),
      visible: me.permissions.includes('document.read'),
    },
    { key: 'measurements', label: t('m.title'), visible: true },
    { key: 'diary', label: t('d.title'), visible: true },
    { key: 'reports', label: t('rep.title'), visible: true },
    { key: 'files', label: t('files.title'), visible: true },
  ]
  const site = [
    project.site.street,
    [project.site.postalCode, project.site.city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <section aria-labelledby="project-title">
      <a
        className="back"
        href="/projekte"
        onClick={(e) => {
          e.preventDefault()
          navigate({ view: 'projects' })
        }}
      >
        ← {t('nav.projects')}
      </a>
      <div className="section-head">
        <h1 id="project-title">
          {project.number ? <span className="muted">{project.number} · </span> : null}
          {project.name}
        </h1>
        {canWrite && !editing ? (
          <button type="button" className="button ghost" onClick={() => setEditing(true)}>
            {t('common.edit')}
          </button>
        ) : null}
      </div>
      <div className="head-meta">
        {canWrite && statuses.length ? (
          <select
            className="select"
            aria-label={t('projects.status')}
            value={project.status?.id ?? ''}
            onChange={(e) => changeStatus(e.target.value)}
          >
            <option value="">{t('projects.noStatus')}</option>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        ) : project.status ? (
          <StatusBadge status={project.status} />
        ) : null}
        {project.archived ? <span className="badge">{t('projects.archived')}</span> : null}
      </div>
      <FormError>{error}</FormError>
      {siteWork && !project.archived ? (
        <div className="offline-prepare">
          <button type="button" className="button ghost auto" onClick={prepare}>
            {t('off.prepare')}
          </button>
          {offline ? (
            <p className="hint" role="status">
              {offline}
            </p>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <ProjectForm
          project={project}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            load()
          }}
        />
      ) : null}

      <nav className="tabs sub" aria-label={t('projects.overview')}>
        {sections
          .filter((s) => s.visible)
          .map((s) => (
            <button
              key={s.key}
              type="button"
              aria-current={section === s.key ? 'page' : undefined}
              onClick={() => navigate({ view: 'project', id, section: s.key })}
            >
              {s.label}
            </button>
          ))}
      </nav>

      {section === 'overview' ? (
        <div className="tiles">
          <div className="tile">
            <h2>{t('projects.customer')}</h2>
            <p>{project.customer?.displayName ?? t('common.none')}</p>
          </div>
          <div className="tile">
            <h2>{t('projects.site')}</h2>
            <p>{site || t('common.none')}</p>
            {site ? (
              <a
                href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(site)}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t('projects.map')}
              </a>
            ) : null}
          </div>
          <div className="tile">
            <h2>{t('projects.period')}</h2>
            <p>{period(project.startDate, project.endDate) || t('common.none')}</p>
          </div>
          <div className="tile">
            <h2>{t('projects.members')}</h2>
            <p>{project.members.map((m) => m.displayName).join(', ') || t('common.none')}</p>
          </div>
          {project.description ? (
            <div className="tile wide">
              <h2>{t('projects.description')}</h2>
              <p className="pre">{project.description}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {section === 'overview' && me.permissions.includes('document.read') ? (
        <>
          <ProjectFiguresPanel projectId={project.id} />
          <ContractPanel projectId={project.id} navigate={navigate} />
        </>
      ) : null}
      {section === 'documents' ? (
        <ProjectDocuments me={me} project={project} navigate={navigate} />
      ) : null}
      {section === 'measurements' ? (
        <ProjectMeasurements
          me={me}
          projectId={project.id}
          archived={project.archived}
          navigate={navigate}
        />
      ) : null}
      {section === 'diary' ? (
        <ProjectDiary
          me={me}
          projectId={project.id}
          archived={project.archived}
          navigate={navigate}
        />
      ) : null}
      {section === 'reports' ? (
        <ProjectReports
          kind="reports"
          me={me}
          projectId={project.id}
          archived={project.archived}
          navigate={navigate}
        />
      ) : null}
      {section === 'files' ? <ProjectFiles me={me} projectId={project.id} /> : null}
    </section>
  )
}
