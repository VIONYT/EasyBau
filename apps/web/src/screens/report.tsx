import type {
  FileSummary,
  FolderSummary,
  Me,
  ReportDetail,
  ReportSection,
  SignerRole,
  UnitSummary,
} from '@opc/schemas'
import { WEATHER_CONDITIONS } from '@opc/schemas/constants'
import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, api, apiWithEtag, uploadFile } from '../api'
import { formatDateTime, formatInputNumber } from '../format'
import { FormError } from '../forms'
import { type TextKey, t } from '../i18n'
import type { Navigate } from '../router'
import {
  initialChoice,
  resolveSignature,
  type SignatureChoice,
  SignatureImage,
  SignatureInput,
  useMySignature,
} from '../signature'

type Data = Record<string, Record<string, unknown>>
type Row = Record<string, string | null | undefined>

const EDITABLE = new Set([
  'weather',
  'staff',
  'services',
  'materials',
  'equipment',
  'text',
  'yes_no',
  'deadline',
])

const sectionTitle = (section: ReportSection) =>
  section.label ?? t(`d.section.${section.type}` as TextKey) ?? section.id

/** Values from the API ("8.5") as input text ("8,5"). */
function toInput(data: Data): Data {
  const result: Data = {}
  for (const [key, value] of Object.entries(data)) {
    const copy: Record<string, unknown> = { ...value }
    if (Array.isArray(copy.rows)) {
      copy.rows = (copy.rows as Row[]).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            k === 'hours' || k === 'quantity' ? formatInputNumber(v ?? '') : v,
          ]),
        ),
      )
    }
    for (const k of ['temperatureMin', 'temperatureMax']) {
      if (typeof copy[k] === 'string') copy[k] = formatInputNumber(copy[k] as string)
    }
    result[key] = copy
  }
  return result
}

/** Empty inputs become null before sending. */
function toRequest(sections: ReportSection[], data: Data): Data {
  const result: Data = {}
  const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
  for (const section of sections.filter((s) => EDITABLE.has(s.type))) {
    const value = data[section.id]
    if (!value) continue
    const copy: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, blank(v)]),
    )
    if (section.type === 'text') copy.text = (value.text as string) ?? ''
    if (Array.isArray(value.rows)) {
      copy.rows = (value.rows as Row[]).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            k === 'name' || k === 'description' ? v : blank(v),
          ]),
        ),
      )
    }
    result[section.id] = copy
  }
  return result
}

/** A report (Bautagesbericht and other templates), rendered from the template's sections. */
export function ReportScreen({ me, id, navigate }: { me: Me; id: string; navigate: Navigate }) {
  const [report, setReport] = useState<ReportDetail | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [data, setData] = useState<Data>({})
  const [reportDate, setReportDate] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [units, setUnits] = useState<UnitSummary[]>([])

  const apply = useCallback(
    ({ data: next, etag: tag }: { data: ReportDetail; etag: string | null }) => {
      setReport(next)
      setEtag(tag)
      setData(toInput(next.data as Data))
      setReportDate(next.reportDate)
      setDirty(false)
    },
    [],
  )

  useEffect(() => {
    apiWithEtag<ReportDetail>('GET', `/api/v1/reports/${id}`)
      .then(apply)
      .catch((err: ApiError) => setError(err.message))
    api<UnitSummary[]>('GET', '/api/v1/units')
      .then(setUnits)
      .catch(() => undefined)
  }, [id, apply])

  const run = async (call: () => Promise<{ data: ReportDetail; etag: string | null }>) => {
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      apply(await call())
      return true
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFieldErrors(err.fieldErrors)
      } else setError(String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  // Photos change on the server immediately; unsaved inputs in the form must stay.
  const applyPhotos = ({ data: next, etag: tag }: { data: ReportDetail; etag: string | null }) => {
    setReport((current) =>
      current ? { ...current, photos: next.photos, photoCount: next.photoCount } : next,
    )
    setEtag(tag)
  }

  if (error && !report) return <FormError>{error}</FormError>
  if (!report) return <p className="muted">{t('common.loading')}</p>

  const editable = report.status === 'draft' && me.permissions.includes('report.write')
  const sections = report.template.sections
  const update = (sectionId: string, value: Record<string, unknown>) => {
    setData((d) => ({ ...d, [sectionId]: value }))
    setDirty(true)
    setSaved(false)
  }
  const save = async () => {
    const ok = await run(() =>
      apiWithEtag<ReportDetail>(
        'PATCH',
        `/api/v1/reports/${report.id}`,
        { reportDate, data: toRequest(sections, data) },
        etag,
      ),
    )
    if (ok) setSaved(true)
    return ok
  }
  const back = () => navigate({ view: 'project', id: report.project.id, section: 'diary' })
  const remove = async () => {
    if (!window.confirm(t('d.deleteConfirm'))) return
    try {
      await api('DELETE', `/api/v1/reports/${report.id}`)
      back()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  const errorList = Object.entries(fieldErrors)

  return (
    <section className="site report" aria-labelledby="report-title">
      <a
        className="back"
        href={`/projekte/${report.project.id}/bautagebuch`}
        onClick={(e) => {
          e.preventDefault()
          back()
        }}
      >
        ← {report.project.number ? `${report.project.number} · ` : ''}
        {report.project.name}
      </a>
      <div className="section-head">
        <h1 id="report-title">
          {report.template.name} – {formatDateTime(report.reportDate, 'date')}
        </h1>
        <span className={`chip chip--${report.status === 'signed' ? 'accepted' : 'draft'}`}>
          {t(`d.status.${report.status}` as TextKey)}
        </span>
      </div>
      <div className="button-row">
        <a
          className="button ghost"
          href={`/api/v1/reports/${report.id}/pdf`}
          target="_blank"
          rel="noopener"
        >
          {t('d.pdf')}
        </a>
      </div>
      {report.status !== 'draft' ? (
        <p className="notice inline" role="status">
          {t('d.locked')}
        </p>
      ) : null}

      <fieldset className="report-body" disabled={!editable || busy}>
        <div className="panel">
          <dl className="facts">
            <dt>{t('d.header.client')}</dt>
            <dd>{report.header.client ?? t('common.none')}</dd>
            <dt>{t('d.header.place')}</dt>
            <dd>{report.header.placeOfPerformance ?? t('common.none')}</dd>
            <dt>{t('d.header.contractor')}</dt>
            <dd>{report.header.contractor}</dd>
          </dl>
          <div className="field">
            <label htmlFor="report-date">{t('d.date')}</label>
            <input
              id="report-date"
              type="date"
              value={reportDate}
              onChange={(e) => {
                setReportDate(e.target.value)
                setDirty(true)
              }}
            />
          </div>
        </div>

        {sections.map((section) => {
          const value = (data[section.id] ?? {}) as Record<string, unknown>
          const set = (next: Record<string, unknown>) => update(section.id, next)
          switch (section.type) {
            case 'weather':
              return <Weather key={section.id} section={section} value={value} set={set} />
            case 'staff':
              return <Staff key={section.id} section={section} value={value} set={set} />
            case 'services':
            case 'materials':
              return (
                <QuantityRows
                  key={section.id}
                  section={section}
                  value={value}
                  set={set}
                  units={units}
                />
              )
            case 'equipment':
              return <Equipment key={section.id} section={section} value={value} set={set} />
            case 'text':
              return (
                <div key={section.id} className="panel">
                  <label className="h2" htmlFor={`text-${section.id}`}>
                    {sectionTitle(section)}
                  </label>
                  <textarea
                    id={`text-${section.id}`}
                    className="textarea"
                    rows={4}
                    value={(value.text as string) ?? ''}
                    onChange={(e) => set({ text: e.target.value })}
                  />
                </div>
              )
            case 'yes_no':
              return (
                <fieldset key={section.id} className="panel segmented-panel">
                  <legend>{sectionTitle(section)}</legend>
                  {[true, false].map((v) => (
                    <label key={String(v)} className="check">
                      <input
                        type="radio"
                        name={section.id}
                        checked={value.value === v}
                        onChange={() => set({ value: v })}
                      />
                      {v ? t('d.yes') : t('d.no')}
                    </label>
                  ))}
                </fieldset>
              )
            case 'deadline':
              return (
                <div key={section.id} className="panel field">
                  <label htmlFor={`deadline-${section.id}`}>{sectionTitle(section)}</label>
                  <input
                    id={`deadline-${section.id}`}
                    type="date"
                    value={(value.date as string) ?? ''}
                    onChange={(e) => set({ date: e.target.value || null })}
                  />
                </div>
              )
            default:
              return null
          }
        })}
      </fieldset>

      {sections.some((s) => s.type === 'photos') ? (
        <Photos report={report} editable={editable} apply={applyPhotos} setError={setError} />
      ) : null}

      {error || errorList.length ? (
        <div className="form-error" role="alert">
          <p>{error}</p>
          {errorList.length ? (
            <ul>
              {errorList.map(([key, message]) => (
                <li key={key}>{message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {editable ? (
        <div className="save-bar">
          <button type="button" className="button primary auto" disabled={busy} onClick={save}>
            {t('d.save')}
          </button>
          {dirty ? <span className="warning">{t('d.unsaved')}</span> : null}
          {saved && !dirty ? (
            <span className="success" role="status">
              {t('d.saved')}
            </span>
          ) : null}
        </div>
      ) : null}

      <Signatures report={report} me={me} busy={busy} save={dirty ? save : null} run={run} />

      {editable &&
      (report.createdBy?.id === me.user.id || me.permissions.includes('project.write')) ? (
        <button type="button" className="button ghost danger" onClick={remove}>
          {t('d.delete')}
        </button>
      ) : null}
    </section>
  )
}

// ---- Sections ---------------------------------------------------------------------------------

type SectionProps = {
  section: ReportSection
  value: Record<string, unknown>
  set: (value: Record<string, unknown>) => void
}

function Weather({ section, value, set }: SectionProps) {
  const field = (name: string) => ({
    value: (value[name] as string | null) ?? '',
    onChange: (e: ChangeEvent<HTMLInputElement>) => set({ ...value, [name]: e.target.value }),
  })
  return (
    <fieldset className="panel">
      <legend className="h2">{sectionTitle(section)}</legend>
      <div className="weather-options" role="radiogroup" aria-label={t('d.weather.condition')}>
        {WEATHER_CONDITIONS.map((c) => (
          <label key={c} className="weather-option">
            <input
              type="radio"
              className="visually-hidden"
              name={`${section.id}-condition`}
              checked={value.condition === c}
              onChange={() => set({ ...value, condition: c })}
            />
            <span>{t(`d.weather.${c}` as TextKey)}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor={`${section.id}-min`}>{t('d.weather.min')}</label>
          <input id={`${section.id}-min`} inputMode="decimal" {...field('temperatureMin')} />
        </div>
        <div className="field">
          <label htmlFor={`${section.id}-max`}>{t('d.weather.max')}</label>
          <input id={`${section.id}-max`} inputMode="decimal" {...field('temperatureMax')} />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${section.id}-note`}>{t('d.weather.note')}</label>
        <input id={`${section.id}-note`} {...field('note')} />
      </div>
    </fieldset>
  )
}

function useRows(value: Record<string, unknown>, set: SectionProps['set'], empty: Row) {
  const rows = (value.rows as Row[] | undefined) ?? []
  return {
    rows,
    change: (index: number, key: string, v: string) =>
      set({ ...value, rows: rows.map((r, i) => (i === index ? { ...r, [key]: v } : r)) }),
    add: () => set({ ...value, rows: [...rows, { ...empty }] }),
    remove: (index: number) => set({ ...value, rows: rows.filter((_, i) => i !== index) }),
  }
}

function RowActions({ onRemove, label }: { onRemove: () => void; label: string }) {
  return (
    <button
      type="button"
      className="button ghost icon danger"
      aria-label={label}
      onClick={onRemove}
    >
      ✕
    </button>
  )
}

function Staff({ section, value, set }: SectionProps) {
  const { rows, change, add, remove } = useRows(value, set, { name: '', hours: '', activity: '' })
  const total = useMemo(() => {
    let hundredths = 0
    for (const row of rows) {
      const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec((row.hours ?? '').trim())
      if (match) hundredths += Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
    }
    return formatInputNumber((hundredths / 100).toFixed(2))
  }, [rows])
  return (
    <fieldset className="panel">
      <legend className="h2">{sectionTitle(section)}</legend>
      {section.transferTimes ? <p className="hint">{t('d.staff.prefilled')}</p> : null}
      <ul className="rows">
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; order is the identity
          <li key={i} className="row-card">
            <div className="row staff-row">
              <div className="field">
                <label htmlFor={`${section.id}-${i}-name`}>{t('d.staff.name')}</label>
                <input
                  id={`${section.id}-${i}-name`}
                  value={row.name ?? ''}
                  onChange={(e) => change(i, 'name', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor={`${section.id}-${i}-hours`}>{t('d.staff.hours')}</label>
                <input
                  id={`${section.id}-${i}-hours`}
                  inputMode="decimal"
                  value={row.hours ?? ''}
                  onChange={(e) => change(i, 'hours', e.target.value)}
                />
              </div>
            </div>
            <div className="row-with-action">
              <div className="field">
                <label htmlFor={`${section.id}-${i}-activity`}>{t('d.staff.activity')}</label>
                <input
                  id={`${section.id}-${i}-activity`}
                  value={row.activity ?? ''}
                  onChange={(e) => change(i, 'activity', e.target.value)}
                />
              </div>
              <RowActions label={t('d.row.remove')} onRemove={() => remove(i)} />
            </div>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button type="button" className="button ghost small" onClick={add}>
          {t('d.row.add')}
        </button>
        <strong className="amount">
          {t('d.staff.total')}: {total} {t('d.hours')}
        </strong>
      </div>
    </fieldset>
  )
}

function QuantityRows({ section, value, set, units }: SectionProps & { units: UnitSummary[] }) {
  const { rows, change, add, remove } = useRows(value, set, {
    description: '',
    quantity: '',
    unitId: '',
  })
  return (
    <fieldset className="panel">
      <legend className="h2">{sectionTitle(section)}</legend>
      <ul className="rows">
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; order is the identity
          <li key={i} className="row-card">
            <div className="field">
              <label htmlFor={`${section.id}-${i}-description`}>{t('d.row.description')}</label>
              <input
                id={`${section.id}-${i}-description`}
                value={row.description ?? ''}
                onChange={(e) => change(i, 'description', e.target.value)}
              />
            </div>
            <div className="row-with-action">
              <div className="row">
                <div className="field">
                  <label htmlFor={`${section.id}-${i}-quantity`}>{t('d.row.quantity')}</label>
                  <input
                    id={`${section.id}-${i}-quantity`}
                    inputMode="decimal"
                    value={row.quantity ?? ''}
                    onChange={(e) => change(i, 'quantity', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${section.id}-${i}-unit`}>{t('d.row.unit')}</label>
                  <select
                    id={`${section.id}-${i}-unit`}
                    className="select"
                    value={row.unitId ?? ''}
                    onChange={(e) => change(i, 'unitId', e.target.value)}
                  >
                    <option value="">–</option>
                    {units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.symbol}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <RowActions label={t('d.row.remove')} onRemove={() => remove(i)} />
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="button ghost small" onClick={add}>
        {t('d.row.add')}
      </button>
    </fieldset>
  )
}

function Equipment({ section, value, set }: SectionProps) {
  const { rows, change, add, remove } = useRows(value, set, { description: '', hours: '' })
  return (
    <fieldset className="panel">
      <legend className="h2">{sectionTitle(section)}</legend>
      <ul className="rows">
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; order is the identity
          <li key={i} className="row-card row-with-action">
            <div className="row">
              <div className="field">
                <label htmlFor={`${section.id}-${i}-description`}>{t('d.row.description')}</label>
                <input
                  id={`${section.id}-${i}-description`}
                  value={row.description ?? ''}
                  onChange={(e) => change(i, 'description', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor={`${section.id}-${i}-hours`}>{t('d.row.hours')}</label>
                <input
                  id={`${section.id}-${i}-hours`}
                  inputMode="decimal"
                  value={row.hours ?? ''}
                  onChange={(e) => change(i, 'hours', e.target.value)}
                />
              </div>
            </div>
            <RowActions label={t('d.row.remove')} onRemove={() => remove(i)} />
          </li>
        ))}
      </ul>
      <button type="button" className="button ghost small" onClick={add}>
        {t('d.row.add')}
      </button>
    </fieldset>
  )
}

// ---- Photos -----------------------------------------------------------------------------------

function Photos({
  report,
  editable,
  apply,
  setError,
}: {
  report: ReportDetail
  editable: boolean
  apply: (r: { data: ReportDetail; etag: string | null }) => void
  setError: (message: string | null) => void
}) {
  const [uploading, setUploading] = useState(false)
  const add = async (selected: FileList | null) => {
    // Copy first: the FileList is emptied when the input is reset right after this call.
    const files = selected ? [...selected] : []
    if (!files.length) return
    setUploading(true)
    setError(null)
    try {
      // Photos are stored in the project's Ablage (folder „Fotos“ if it exists).
      const folders = await api<FolderSummary[]>(
        'GET',
        `/api/v1/projects/${report.projectId}/folders`,
      )
      const folder = folders.find((f) => f.name === 'Fotos')
      let latest: { data: ReportDetail; etag: string | null } | null = null
      for (const file of files) {
        const query = new URLSearchParams({ filename: file.name || 'Foto.jpg' })
        if (folder) query.set('folderId', folder.id)
        const stored = await uploadFile<FileSummary>(
          `/api/v1/projects/${report.projectId}/files?${query}`,
          file,
        )
        latest = await apiWithEtag<ReportDetail>('POST', `/api/v1/reports/${report.id}/photos`, {
          fileId: stored.id,
        })
      }
      if (latest) apply(latest)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setUploading(false)
    }
  }
  const remove = async (fileId: string) => {
    try {
      apply(
        await apiWithEtag<ReportDetail>('DELETE', `/api/v1/reports/${report.id}/photos/${fileId}`),
      )
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  return (
    <div className="panel">
      <h2>{t('d.section.photos')}</h2>
      {report.photos.length ? (
        <ul className="file-grid">
          {report.photos.map((p) => (
            <li key={p.fileId} className="file-card">
              <a
                className="file-preview"
                href={`/api/v1/files/${p.fileId}/content`}
                target="_blank"
                rel="noopener"
              >
                <img
                  src={`/api/v1/files/${p.fileId}/content`}
                  alt={p.caption ?? p.filename}
                  loading="lazy"
                />
              </a>
              <span className="file-info">{p.caption ?? p.filename}</span>
              {editable ? (
                <button
                  type="button"
                  className="button ghost small danger"
                  onClick={() => remove(p.fileId)}
                >
                  {t('d.photo.remove')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editable ? (
        <label className="button ghost file-button">
          {uploading ? t('d.photo.uploading') : t('d.photo.add')}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="visually-hidden"
            disabled={uploading}
            onChange={(e) => {
              add(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      ) : null}
    </div>
  )
}

// ---- Signatures -------------------------------------------------------------------------------

function Signatures({
  report,
  me,
  busy,
  save,
  run,
}: {
  report: ReportDetail
  me: Me
  busy: boolean
  save: (() => Promise<boolean>) | null
  run: (call: () => Promise<{ data: ReportDetail; etag: string | null }>) => Promise<boolean>
}) {
  const roles: SignerRole[] = [
    ...new Set(
      report.template.sections.filter((s) => s.type === 'signatures').flatMap((s) => s.roles ?? []),
    ),
  ]
  const [names, setNames] = useState<Record<string, string>>({ contractor: me.user.displayName })
  const [mine] = useMySignature()
  // The signed-in user signs as Auftragnehmer; everyone else draws on this device.
  const [choices, setChoices] = useState<Record<string, SignatureChoice>>(() =>
    Object.fromEntries(roles.map((role) => [role, initialChoice(role === 'contractor')])),
  )
  if (report.signatures.length) {
    return (
      <div className="panel">
        <h2>{t('d.section.signatures')}</h2>
        <ul className="list plain signature-list">
          {report.signatures.map((s) => (
            <li key={`${s.role}-${s.signedAt}`}>
              <strong>{s.name}</strong> ({t(`d.role.${s.role}` as TextKey)}), {t('d.signedAt')}{' '}
              {formatDateTime(s.signedAt)}
              {s.imageAssetId ? (
                <SignatureImage
                  url={`/api/v1/assets/${s.imageAssetId}`}
                  alt={t(`sig.${s.role}` as TextKey)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (report.status !== 'draft' || !me.permissions.includes('report.sign') || !roles.length)
    return null
  const sign = async () => {
    if (save && !(await save())) return
    if (!window.confirm(t('d.signConfirm'))) return
    await run(async () => {
      const signatures = []
      for (const role of roles) {
        const choice = choices[role] ?? initialChoice(false)
        signatures.push({
          role,
          name: names[role] ?? '',
          signatureAssetId: await resolveSignature(choice, role === 'contractor' ? mine : null),
        })
      }
      return apiWithEtag<ReportDetail>('POST', `/api/v1/reports/${report.id}/sign`, {
        signatures,
      })
    })
  }
  return (
    <div className="panel">
      <h2>{t('d.sign')}</h2>
      <p className="hint">{t('d.signHint')}</p>
      {roles.map((role) => (
        <div key={role} className="field">
          <label htmlFor={`signer-${role}`}>{t(`d.signer.${role}` as TextKey)}</label>
          <input
            id={`signer-${role}`}
            value={names[role] ?? ''}
            onChange={(e) => setNames({ ...names, [role]: e.target.value })}
          />
          <SignatureInput
            id={`signature-${role}`}
            label={t(`sig.${role}` as TextKey)}
            own={role === 'contractor'}
            mine={role === 'contractor' ? mine : null}
            choice={choices[role] ?? initialChoice(role === 'contractor')}
            onChange={(choice) => setChoices((current) => ({ ...current, [role]: choice }))}
          />
        </div>
      ))}
      <button type="button" className="button primary auto" disabled={busy} onClick={sign}>
        {t('d.sign')}
      </button>
    </div>
  )
}
