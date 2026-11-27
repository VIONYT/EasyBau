import {
  FormulaError,
  MEASUREMENT_TEMPLATES,
  measurementLineQuantity,
  tryEvaluateFormula,
} from '@easybau/domain'
import type {
  Me,
  MeasurableDocumentRef,
  MeasurableItem,
  MeasurementLine,
  MeasurementLocation,
  MeasurementSheetDetail,
  UnitSummary,
} from '@easybau/schemas'
import { Button, buttonClass } from '@easybau/ui'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, api, apiWithEtag, mutate } from '../api'
import { formatDateTime, formatInputNumber, formatQuantity, formatUnitAmount } from '../format'
import { Field, FormError, optional, SelectField, useForm, value } from '../forms'
import { type TextKey, t } from '../i18n'
import { useOnline } from '../offline/client'
import type { Navigate } from '../router'
import {
  initialChoice,
  resolveSignature,
  type SignatureChoice,
  SignatureImage,
  SignatureInput,
  useMySignature,
} from '../signature'
import { documentLabel } from './documents'
import { VariancePanel } from './variances'

type Sheet = MeasurementSheetDetail
type Apply = (result: { data: Sheet; etag: string | null }) => void
/** A line captured offline that has not reached the server yet (ADR 0010). */
type LocalLine = MeasurementLine & { pending?: boolean }

const sheetPath = (sheet: Pick<Sheet, 'id'>) => `/api/v1/measurement-sheets/${sheet.id}`

interface LineInput {
  locationId: string | null
  documentItemId: string | null
  description: string | null
  formula: string
  isDeduction: boolean
  unitId?: string | null
}

/**
 * The line as it will look after the sync: quantity with the same domain rule as the server
 * (preview only – the server computes it again, rule 11).
 */
function provisionalLine(
  sheet: Sheet,
  id: string,
  input: LineInput,
  items: MeasurableItem[],
  units: UnitSummary[],
  previous?: MeasurementLine,
): LocalLine {
  const item = input.documentItemId ? items.find((i) => i.id === input.documentItemId) : undefined
  const chosen = input.unitId ? units.find((u) => u.id === input.unitId) : undefined
  const unit =
    item?.unit ??
    (chosen
      ? { id: chosen.id, symbol: chosen.symbol, decimals: chosen.decimals }
      : (previous?.unit ?? null))
  let resultQty: string
  try {
    resultQty = measurementLineQuantity({
      formula: input.formula,
      locationVariables: roomVariables(sheet.locations, input.locationId),
      variables: previous?.variables ?? {},
      isDeduction: input.isDeduction,
      decimals: unit?.decimals ?? 2,
    })
  } catch (error) {
    if (error instanceof FormulaError) {
      throw new ApiError(400, error.message, { formula: error.message })
    }
    throw error
  }
  return {
    id,
    locationId: input.locationId,
    documentItemId: input.documentItemId,
    description: input.description,
    formula: input.formula,
    variables: previous?.variables ?? {},
    resultQty,
    isDeduction: input.isDeduction,
    unit,
    locked: false,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    pending: true,
  }
}

export function refLabel(ref: MeasurableDocumentRef): string {
  const label = documentLabel({
    type: ref.type,
    invoiceKind: ref.invoiceKind,
    progressNo: ref.progressNo,
    changeOrder: ref.changeOrderNumber ? { number: ref.changeOrderNumber } : null,
  })
  return ref.number ? `${label} ${ref.number}` : `${label} (${t('doc.status.draft')})`
}

const itemLabel = (item: MeasurableItem) =>
  `${item.oz ? `${item.oz} ` : ''}${item.shortText}${item.unit ? ` [${item.unit.symbol}]` : ''}`

/** Room variables including those of the parent areas (same rule as on the server). */
function roomVariables(locations: MeasurementLocation[], locationId: string | null) {
  const byId = new Map(locations.map((l) => [l.id, l]))
  const chain: MeasurementLocation[] = []
  let current = locationId ? byId.get(locationId) : undefined
  while (current && chain.length < 20) {
    chain.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return Object.assign({}, ...chain.map((l) => l.variables)) as Record<string, string>
}

const VARIABLE_ORDER = ['L', 'B', 'H']
const rank = (name: string) => {
  const i = VARIABLE_ORDER.indexOf(name)
  return i === -1 ? VARIABLE_ORDER.length : i
}

/** „L 4,25 · B 3,1 · H 2,6“ – always in this order (jsonb does not keep the key order). */
const formatVariables = (vars: Record<string, string>) =>
  Object.entries(vars)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([k, v]) => `${k} ${formatInputNumber(v)}`)
    .join(' · ')

/** Aufmaßblatt: rooms, formula lines, quantities per LV position, joint measurement. */
export function MeasurementScreen({
  me,
  id,
  navigate,
}: {
  me: Me
  id: string
  navigate: Navigate
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<MeasurableItem[]>([])
  const [units, setUnits] = useState<UnitSummary[]>([])
  const online = useOnline()

  const apply: Apply = useCallback(({ data }) => setSheet(data), [])
  useEffect(() => {
    apiWithEtag<Sheet>('GET', `/api/v1/measurement-sheets/${id}`)
      .then(apply)
      .catch((err: ApiError) => setError(err.message))
    api<UnitSummary[]>('GET', '/api/v1/units')
      .then(setUnits)
      .catch(() => undefined)
  }, [id, apply])
  useEffect(() => {
    if (!sheet) return
    api<MeasurableItem[]>(
      'GET',
      `/api/v1/projects/${sheet.projectId}/measurable-items?kind=${sheet.kind}`,
    )
      .then(setItems)
      .catch(() => undefined)
  }, [sheet?.projectId, sheet?.kind, sheet])

  if (error && !sheet) return <FormError>{error}</FormError>
  if (!sheet) return <p className="muted">{t('common.loading')}</p>

  const editable = sheet.status === 'draft' && me.permissions.includes('measurement.write')
  const back = () => navigate({ view: 'project', id: sheet.project.id, section: 'measurements' })
  const remove = async () => {
    if (!window.confirm(t('m.deleteSheetConfirm'))) return
    try {
      await api('DELETE', `/api/v1/measurement-sheets/${sheet.id}`)
      back()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  return (
    <section className="site" aria-labelledby="measurement-title">
      <a
        className="back"
        href={`/projekte/${sheet.project.id}/aufmass`}
        onClick={(e) => {
          e.preventDefault()
          back()
        }}
      >
        ← {sheet.project.number ? `${sheet.project.number} · ` : ''}
        {sheet.project.name}
      </a>
      <div className="section-head">
        <h1 id="measurement-title">{sheet.title}</h1>
        <span className={`chip chip--${sheet.status === 'signed' ? 'accepted' : 'draft'}`}>
          {t(`m.status.${sheet.status}` as TextKey)}
        </span>
      </div>
      <p className="muted">
        {t(`m.kind.${sheet.kind}` as TextKey)} · {formatDateTime(sheet.measuredOn, 'date')}
      </p>
      {online ? (
        <div className="button-row">
          <a
            className={buttonClass({ variant: 'ghost', width: 'natural' })}
            href={`/api/v1/measurement-sheets/${sheet.id}/pdf`}
            target="_blank"
            rel="noopener"
          >
            {t('m.pdf')}
          </a>
        </div>
      ) : (
        <p className="hint">{t('off.siteOnlineOnly')}</p>
      )}
      {sheet.status === 'signed' ? (
        <div className="notice inline signature-list" role="status">
          {t('m.signedBy')} {formatDateTime(sheet.signedAt)}: {sheet.signedByContractor} /{' '}
          {sheet.signedByClient}
          {sheet.contractorSignatureAssetId || sheet.clientSignatureAssetId ? (
            <div className="row">
              {sheet.contractorSignatureAssetId ? (
                <SignatureImage
                  url={`/api/v1/assets/${sheet.contractorSignatureAssetId}`}
                  alt={t('sig.contractor')}
                />
              ) : null}
              {sheet.clientSignatureAssetId ? (
                <SignatureImage
                  url={`/api/v1/assets/${sheet.clientSignatureAssetId}`}
                  alt={t('sig.client')}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <FormError>{error}</FormError>

      <Rooms sheet={sheet} editable={editable} apply={apply} />
      <Lines sheet={sheet} editable={editable} items={items} units={units} apply={apply} />
      <Quantities me={me} sheet={sheet} />
      {sheet.kind === 'performance' && me.permissions.includes('document.write') ? (
        <VariancePanel sheet={sheet} lineCount={sheet.lines.length} navigate={navigate} />
      ) : null}
      {editable && online ? <SignPanel sheet={sheet} me={me} apply={apply} /> : null}
      {editable && online ? (
        <Button type="button" variant="ghost" width="natural" danger onClick={remove}>
          {t('m.deleteSheet')}
        </Button>
      ) : null}
    </section>
  )
}

// ---- Rooms ------------------------------------------------------------------------------------

function Rooms({ sheet, editable, apply }: { sheet: Sheet; editable: boolean; apply: Apply }) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const remove = async (room: MeasurementLocation) => {
    if (!window.confirm(t('m.deleteRoomConfirm'))) return
    setError(null)
    try {
      apply(
        await apiWithEtag<Sheet>(
          'DELETE',
          `/api/v1/measurement-sheets/${sheet.id}/locations/${room.id}`,
        ),
      )
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  return (
    <details className="panel" open={editable || sheet.locations.length > 0}>
      <summary>
        <h2 className="summary-title">{t('m.rooms')}</h2>
      </summary>
      <p className="hint">{t('m.roomsHint')}</p>
      <FormError>{error}</FormError>
      {!sheet.locations.length ? <p className="muted">{t('m.roomsEmpty')}</p> : null}
      {sheet.locations.length ? (
        <ul className="rooms">
          {sheet.locations.map((room) => (
            <li
              key={room.id}
              style={{ paddingInlineStart: `calc(${room.level} * var(--space-4))` }}
            >
              {editingId === room.id ? (
                <RoomForm
                  sheet={sheet}
                  room={room}
                  apply={apply}
                  onDone={() => setEditingId(null)}
                />
              ) : (
                <div className="room-row">
                  <span>
                    <strong>{room.name}</strong>
                    {Object.keys(room.variables).length ? (
                      <span className="muted block">{formatVariables(room.variables)}</span>
                    ) : null}
                  </span>
                  {editable ? (
                    <span className="actions">
                      <Button
                        type="button"
                        variant="ghost"
                        width="natural"
                        size="small"
                        onClick={() => setEditingId(room.id)}
                      >
                        {t('common.edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        width="natural"
                        size="icon"
                        danger
                        aria-label={`${t('m.deleteRoom')}: ${room.name}`}
                        onClick={() => remove(room)}
                      >
                        ✕
                      </Button>
                    </span>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {editable && adding ? (
        <RoomForm sheet={sheet} apply={apply} onDone={() => setAdding(false)} />
      ) : null}
      {editable && !adding ? (
        <Button type="button" variant="ghost" width="natural" onClick={() => setAdding(true)}>
          + {t('m.addRoom')}
        </Button>
      ) : null}
    </details>
  )
}

function RoomForm({
  sheet,
  room,
  apply,
  onDone,
}: {
  sheet: Sheet
  room?: MeasurementLocation
  apply: Apply
  onDone: () => void
}) {
  const form = useForm(
    async (data) => {
      const variables: Record<string, string> = { ...(room?.variables ?? {}) }
      for (const name of ['L', 'B', 'H']) {
        const v = value(data, name)
        if (v) variables[name] = v
        else delete variables[name]
      }
      const body = { name: value(data, 'name'), variables }
      if (room) {
        return apiWithEtag<Sheet>(
          'PATCH',
          `/api/v1/measurement-sheets/${sheet.id}/locations/${room.id}`,
          body,
        )
      }
      // New rooms get their id on the device: they can be created offline (outbox, ADR 0010).
      const id = crypto.randomUUID()
      const parentId = optional(data, 'parentId') ?? null
      return mutate<Sheet>({
        method: 'POST',
        path: `${sheetPath(sheet)}/locations`,
        json: { ...body, id, parentId },
        resource: sheetPath(sheet),
        label: `${t('m.rooms')}: ${body.name}`,
        optimistic: (current) => {
          const base = current ?? sheet
          const parent = base.locations.find((l) => l.id === parentId)
          return {
            ...base,
            locations: [
              ...base.locations,
              {
                id,
                parentId,
                name: body.name,
                variables,
                path: parent ? `${parent.path} › ${body.name}` : body.name,
                level: parent ? parent.level + 1 : 0,
              },
            ],
          }
        },
      })
    },
    (result) => {
      apply(result)
      onDone()
    },
  )
  const errorOf = (name: string) =>
    form.fieldErrors[`variables.${name}`] ??
    (form.fieldErrors.variables ? form.fieldErrors.variables : undefined)
  return (
    <form className="item-form" onSubmit={form.onSubmit} noValidate>
      <FormError>{form.error}</FormError>
      <Field
        label={t('m.roomName')}
        name="name"
        required
        defaultValue={room?.name}
        error={form.fieldErrors.name}
      />
      {!room && sheet.locations.length ? (
        <SelectField
          label={t('m.parent')}
          name="parentId"
          defaultValue=""
          options={[
            { value: '', label: t('m.noParent') },
            ...sheet.locations.map((l) => ({ value: l.id, label: l.path })),
          ]}
        />
      ) : null}
      <div className="row three">
        {(
          [
            ['L', 'm.length'],
            ['B', 'm.width'],
            ['H', 'm.height'],
          ] as const
        ).map(([name, label]) => (
          <Field
            key={name}
            label={t(label)}
            name={name}
            inputMode="decimal"
            defaultValue={formatInputNumber(room?.variables[name])}
            error={errorOf(name)}
          />
        ))}
      </div>
      <div className="button-row">
        <Button type="submit" variant="primary" disabled={form.busy}>
          {room ? t('common.save') : t('common.add')}
        </Button>
        <Button type="button" variant="ghost" width="natural" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

// ---- Lines ------------------------------------------------------------------------------------

function Lines({
  sheet,
  editable,
  items,
  units,
  apply,
}: {
  sheet: Sheet
  editable: boolean
  items: MeasurableItem[]
  units: UnitSummary[]
  apply: Apply
}) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const groups = useMemo(() => {
    const result: { key: string; title: string; lines: MeasurementLine[] }[] = []
    for (const line of sheet.lines) {
      const key = line.locationId ?? ''
      let group = result.find((g) => g.key === key)
      if (!group) {
        const room = sheet.locations.find((l) => l.id === line.locationId)
        group = { key, title: room?.path ?? t('m.noRoom'), lines: [] }
        result.push(group)
      }
      group.lines.push(line)
    }
    return result
  }, [sheet])

  const remove = async (line: MeasurementLine) => {
    if (!window.confirm(t('m.deleteLineConfirm'))) return
    setError(null)
    try {
      apply(
        await mutate<Sheet>({
          method: 'DELETE',
          path: `${sheetPath(sheet)}/lines/${line.id}`,
          resource: sheetPath(sheet),
          label: `${t('common.delete')}: ${line.formula}`,
          optimistic: (current) => {
            const base = current ?? sheet
            return { ...base, lines: base.lines.filter((l) => l.id !== line.id) }
          },
        }),
      )
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  return (
    <div className="panel">
      <h2>{t('m.lines')}</h2>
      <FormError>{error}</FormError>
      {sheet.lines.some((l) => (l as LocalLine).pending) ? (
        <p className="hint">{t('off.sumsLater')}</p>
      ) : null}
      {groups.map((group) => (
        <div key={group.key} className="line-group">
          <h3>{group.title}</h3>
          <ul className="m-lines">
            {group.lines.map((line) =>
              editingId === line.id ? (
                <li key={line.id}>
                  <LineForm
                    sheet={sheet}
                    line={line}
                    items={items}
                    units={units}
                    apply={apply}
                    onDone={() => setEditingId(null)}
                  />
                </li>
              ) : (
                <li key={line.id} className="m-line">
                  <div className="m-line-main">
                    <span>
                      {line.description ? (
                        <strong className="block">{line.description}</strong>
                      ) : null}
                      <code className="formula">{line.formula.replace(/\./g, ',')}</code>
                      {(line as LocalLine).pending ? (
                        <span className="not-synced">{t('off.notSynced')}</span>
                      ) : null}
                      {line.isDeduction ? (
                        <span className="tag">{t('m.deductionShort')}</span>
                      ) : null}
                      <span className="muted block">
                        {line.documentItemId
                          ? itemById.get(line.documentItemId)
                            ? itemLabel(itemById.get(line.documentItemId) as MeasurableItem)
                            : t('m.item')
                          : t('m.noItem')}
                      </span>
                    </span>
                    <span className="amount result">
                      {formatUnitAmount(line.resultQty, line.unit?.decimals)} {line.unit?.symbol}
                    </span>
                  </div>
                  {editable && !line.locked ? (
                    <span className="actions">
                      <Button
                        type="button"
                        variant="ghost"
                        width="natural"
                        size="icon"
                        aria-label={`${t('m.editLine')}: ${line.description ?? line.formula}`}
                        onClick={() => setEditingId(line.id)}
                      >
                        ✎
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        width="natural"
                        size="icon"
                        danger
                        aria-label={t('common.delete')}
                        onClick={() => remove(line)}
                      >
                        ✕
                      </Button>
                    </span>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
      {editable && adding ? (
        <LineForm
          sheet={sheet}
          items={items}
          units={units}
          apply={apply}
          onDone={() => setAdding(false)}
        />
      ) : null}
      {editable && !adding ? (
        <Button type="button" variant="primary" onClick={() => setAdding(true)}>
          + {t('m.addLine')}
        </Button>
      ) : null}
    </div>
  )
}

function LineForm({
  sheet,
  line,
  items,
  units,
  apply,
  onDone,
}: {
  sheet: Sheet
  line?: MeasurementLine
  items: MeasurableItem[]
  units: UnitSummary[]
  apply: Apply
  onDone: () => void
}) {
  // The last used room and position stay selected: on site many lines follow each other.
  const last = sheet.lines.at(-1)
  const [locationId, setLocationId] = useState(line?.locationId ?? last?.locationId ?? '')
  const [itemId, setItemId] = useState(line?.documentItemId ?? last?.documentItemId ?? '')
  const [formula, setFormula] = useState(line?.formula.replace(/\./g, ',') ?? '')
  const [isDeduction, setIsDeduction] = useState(line?.isDeduction ?? false)
  const [unitId, setUnitId] = useState(line?.documentItemId ? '' : (line?.unit?.id ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const variables = roomVariables(sheet.locations, locationId || null)
  const preview = formula.trim()
    ? tryEvaluateFormula(formula, { ...variables, ...line?.variables })
    : null
  const item = items.find((i) => i.id === itemId)
  const documents = [...new Map(items.map((i) => [i.document.id, i.document])).values()]

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const body = {
      locationId: locationId || null,
      documentItemId: itemId || null,
      description: optional(data, 'description') ?? null,
      formula,
      isDeduction,
      ...(itemId ? {} : { unitId: unitId || null }),
    }
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      // New lines get their id on the device, so the outbox can send them again safely.
      const lineId = line?.id ?? crypto.randomUUID()
      apply(
        await mutate<Sheet>({
          method: line ? 'PATCH' : 'POST',
          path: line ? `${sheetPath(sheet)}/lines/${line.id}` : `${sheetPath(sheet)}/lines`,
          json: line ? body : { ...body, id: lineId },
          resource: sheetPath(sheet),
          label: `${t('m.lines')}: ${formula}`,
          optimistic: (current) => {
            const base = current ?? sheet
            const next = provisionalLine(base, lineId, body, items, units, line)
            return {
              ...base,
              lines: line
                ? base.lines.map((l) => (l.id === line.id ? next : l))
                : [...base.lines, next],
            }
          },
        }),
      )
      onDone()
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFieldErrors(err.fieldErrors)
      } else setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  // Rounded like on the server: to the decimals of the unit (m² 2, m³/t 3, Stück 0).
  const decimals = itemId ? item?.unit?.decimals : units.find((u) => u.id === unitId)?.decimals
  const shown = preview?.ok
    ? isDeduction
      ? `−${formatUnitAmount(preview.quantity.replace(/^-/, ''), decimals)}`
      : formatUnitAmount(preview.quantity, decimals)
    : null

  return (
    <form className="item-form" onSubmit={submit} noValidate>
      <h3>{line ? t('m.editLine') : t('m.addLine')}</h3>
      <FormError>{error}</FormError>
      <div className="row">
        <SelectField
          label={t('m.room')}
          name="locationId"
          value={locationId}
          onChange={setLocationId}
          options={[
            { value: '', label: t('m.noRoom') },
            ...sheet.locations.map((l) => ({ value: l.id, label: l.path })),
          ]}
          error={fieldErrors.locationId}
        />
        <div className="field">
          <label htmlFor="m-item">{t('m.item')}</label>
          <select
            id="m-item"
            className="select"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
          >
            <option value="">{t('m.noItem')}</option>
            {documents.map((doc) => (
              <optgroup key={doc.id} label={refLabel(doc)}>
                {items
                  .filter((i) => i.document.id === doc.id)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {itemLabel(i)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          {fieldErrors.documentItemId ? (
            <p className="field-error">{fieldErrors.documentItemId}</p>
          ) : null}
        </div>
      </div>
      <Field
        label={t('m.description')}
        name="description"
        defaultValue={line?.description ?? ''}
        error={fieldErrors.description}
      />
      <fieldset className="templates">
        <legend>{t('m.templates')}</legend>
        {MEASUREMENT_TEMPLATES.map((tpl) => (
          <Button
            key={tpl.id}
            type="button"
            variant="ghost"
            width="natural"
            size="small"
            onClick={() => {
              setFormula(tpl.formula)
              setIsDeduction(Boolean(tpl.isDeduction))
            }}
          >
            {tpl.label}
          </Button>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="m-formula">
          {t('m.formula')}
          <span aria-hidden="true"> *</span>
        </label>
        <input
          id="m-formula"
          className="formula-input"
          name="formula"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
          aria-invalid={fieldErrors.formula || (preview && !preview.ok) ? true : undefined}
          aria-describedby="m-formula-hint m-formula-result"
        />
        <p id="m-formula-hint" className="hint">
          {t('m.formulaHint')}
          {Object.keys(variables).length ? ` ${t('m.room')}: ${formatVariables(variables)}` : ''}
        </p>
        <p
          id="m-formula-result"
          className={preview && !preview.ok ? 'field-error' : 'result-line'}
          aria-live="polite"
        >
          {preview
            ? preview.ok
              ? `${t('m.result')}: ${shown} ${(itemId ? item?.unit?.symbol : units.find((u) => u.id === unitId)?.symbol) ?? ''}`
              : preview.error.message
            : ''}
        </p>
        {fieldErrors.formula ? <p className="field-error">{fieldErrors.formula}</p> : null}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={isDeduction}
          onChange={(e) => setIsDeduction(e.target.checked)}
        />
        {t('m.deduction')}
      </label>
      {itemId ? (
        <p className="hint">
          {t('m.unitFromItem')}: {item?.unit?.symbol ?? '–'}
        </p>
      ) : (
        <SelectField
          label={t('m.unit')}
          name="unitId"
          value={unitId}
          onChange={setUnitId}
          options={[
            { value: '', label: '–' },
            ...units.map((u) => ({ value: u.id, label: `${u.symbol} – ${u.name}` })),
          ]}
          error={fieldErrors.unitId}
        />
      )}
      <div className="button-row">
        <Button type="submit" variant="primary" disabled={busy}>
          {line ? t('common.save') : t('common.add')}
        </Button>
        <Button type="button" variant="ghost" width="natural" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
}

// ---- Quantities per LV position -----------------------------------------------------------------

function Quantities({ me, sheet }: { me: Me; sheet: Sheet }) {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const drafts = [
    ...new Map(
      sheet.items
        .filter((s) => s.item.document.status === 'draft')
        .map((s) => [s.item.document.id, s.item.document]),
    ).values(),
  ]
  const applyTo = async (doc: MeasurableDocumentRef) => {
    setMessage(null)
    setError(null)
    try {
      await api('POST', `/api/v1/documents/${doc.id}/apply-measurements`)
      setMessage(`${t('m.applied')} (${refLabel(doc)})`)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  return (
    <div className="panel">
      <h2>{t('m.quantities')}</h2>
      {!sheet.items.length ? <p className="muted">{t('m.quantitiesEmpty')}</p> : null}
      {sheet.items.length ? (
        <ul className="quantities">
          {sheet.items.map(({ item, sheetQuantity, variance }) => (
            <li key={item.id}>
              <strong>{itemLabel(item)}</strong>
              <span className="muted block">{refLabel(item.document)}</span>
              <dl className="q-facts">
                <div>
                  <dt>{t('m.thisSheet')}</dt>
                  <dd>{formatUnitAmount(sheetQuantity, item.unit?.decimals)}</dd>
                </div>
                <div>
                  <dt>{t('m.measuredTotal')}</dt>
                  <dd>{formatUnitAmount(item.measuredQuantity, item.unit?.decimals)}</dd>
                </div>
                <div>
                  <dt>{t('m.lvQuantity')}</dt>
                  <dd>{formatUnitAmount(item.quantity, item.unit?.decimals)}</dd>
                </div>
              </dl>
              {variance.direction !== 'equal' ? (
                <p className={variance.exceedsThreshold ? 'warning' : 'muted'}>
                  {variance.direction === 'more' ? t('m.more') : t('m.less')}{' '}
                  {formatUnitAmount(variance.difference.replace(/^-/, ''), item.unit?.decimals)}{' '}
                  {item.unit?.symbol}
                  {variance.percent ? ` (${formatQuantity(variance.percent)} %)` : ''}
                  {variance.exceedsThreshold ? ` – ${t('m.vobHint')}` : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {sheet.unassigned.length ? (
        <p className="muted">
          {t('m.unassigned')}:{' '}
          {sheet.unassigned
            .map((u) => `${formatUnitAmount(u.quantity, u.decimals)} ${u.unit ?? ''} (${u.count})`)
            .join(' · ')}
        </p>
      ) : null}
      {me.permissions.includes('document.write') && drafts.length ? (
        <div className="stack">
          <p className="hint">{t('m.applyHint')}</p>
          {drafts.map((doc) => (
            <Button
              key={doc.id}
              type="button"
              variant="ghost"
              width="natural"
              onClick={() => applyTo(doc)}
            >
              {t('m.apply')} {refLabel(doc)}
            </Button>
          ))}
        </div>
      ) : null}
      {message ? (
        <p className="success" role="status">
          {message}
        </p>
      ) : null}
      <FormError>{error}</FormError>
    </div>
  )
}

// ---- Joint measurement ------------------------------------------------------------------------

function SignPanel({ sheet, me, apply }: { sheet: Sheet; me: Me; apply: Apply }) {
  const [mine] = useMySignature()
  const [contractor, setContractor] = useState<SignatureChoice>(() => initialChoice(true))
  const [client, setClient] = useState<SignatureChoice>(() => initialChoice(false))
  const form = useForm(async (data) => {
    if (!window.confirm(t('m.signConfirm'))) throw new ApiError(0, '')
    return apiWithEtag<Sheet>('POST', `/api/v1/measurement-sheets/${sheet.id}/sign`, {
      contractorName: value(data, 'contractorName'),
      clientName: value(data, 'clientName'),
      contractorSignatureAssetId: await resolveSignature(contractor, mine),
      clientSignatureAssetId: await resolveSignature(client, null),
    })
  }, apply)
  return (
    <details className="panel">
      <summary>
        <h2 className="summary-title">{t('m.sign')}</h2>
      </summary>
      <form onSubmit={form.onSubmit} noValidate>
        <p className="hint">{t('m.signHint')}</p>
        <FormError>{form.error || null}</FormError>
        <div className="row">
          <Field
            label={t('m.contractor')}
            name="contractorName"
            required
            defaultValue={me.user.displayName}
            error={form.fieldErrors.contractorName}
          />
          <Field
            label={t('m.client')}
            name="clientName"
            required
            error={form.fieldErrors.clientName}
          />
        </div>
        <div className="signature-row">
          <SignatureInput
            id="signature-contractor"
            label={t('sig.contractor')}
            own
            mine={mine}
            choice={contractor}
            onChange={setContractor}
          />
          <SignatureInput
            id="signature-client"
            label={t('sig.client')}
            own={false}
            mine={null}
            choice={client}
            onChange={setClient}
          />
        </div>
        <Button type="submit" variant="primary" disabled={form.busy || !sheet.lines.length}>
          {t('m.sign')}
        </Button>
      </form>
    </details>
  )
}
