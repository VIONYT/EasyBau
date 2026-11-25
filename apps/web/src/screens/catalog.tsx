import type {
  CatalogFolder,
  CatalogItem,
  ImportResult,
  Me,
  SupplierArticle,
  SupplierCatalog,
  UnitSummary,
} from '@easybau/schemas'
import { COST_KINDS } from '@easybau/schemas/constants'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api, uploadFile } from '../api'
import {
  centsToInput,
  formatCents,
  formatDateTime,
  formatInputNumber,
  formatQuantity,
  parseEuro,
} from '../format'
import { FormError, SelectField } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import { CatalogImport } from './catalog-import'

type Section = 'service' | 'material' | 'catalogs'

/** Stammdaten: Leistungen, Materialien and supplier catalogs (DATANORM). */
export function Catalog({ me }: { me: Me }) {
  const [section, setSection] = useState<Section>('service')
  const [units, setUnits] = useState<UnitSummary[]>([])
  useEffect(() => {
    api<UnitSummary[]>('GET', '/api/v1/units')
      .then(setUnits)
      .catch(() => undefined)
  }, [])
  const canWrite = me.permissions.includes('catalog.write')
  return (
    <section aria-labelledby="catalog-title">
      <h1 id="catalog-title">{t('nav.catalog')}</h1>
      <nav className="tabs sub" aria-label={t('nav.catalog')}>
        {(
          [
            ['service', 'c.services'],
            ['material', 'c.materials'],
            ['catalogs', 'c.catalogs'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-current={section === key ? 'page' : undefined}
            onClick={() => setSection(key)}
          >
            {t(label)}
          </button>
        ))}
      </nav>
      {section === 'catalogs' ? (
        <SupplierCatalogs canWrite={canWrite} units={units} />
      ) : (
        <ItemList key={section} kind={section} canWrite={canWrite} units={units} />
      )}
    </section>
  )
}

// ---- Leistungen / Materialien -----------------------------------------------------------------

function ItemList({
  kind,
  canWrite,
  units,
}: {
  kind: 'service' | 'material'
  canWrite: boolean
  units: UnitSummary[]
}) {
  const [items, setItems] = useState<CatalogItem[] | null>(null)
  const [folders, setFolders] = useState<CatalogFolder[]>([])
  const [folderId, setFolderId] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<CatalogItem | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    const params = new URLSearchParams({ kind })
    if (folderId) params.set('folderId', folderId)
    if (query.trim()) params.set('q', query.trim())
    api<CatalogItem[]>('GET', `/api/v1/catalog/items?${params}`)
      .then(setItems)
      .catch((err: ApiError) => setError(err.message))
  }, [kind, folderId, query])

  useEffect(() => {
    const timer = setTimeout(reload, 200)
    return () => clearTimeout(timer)
  }, [reload])
  useEffect(() => {
    api<CatalogFolder[]>('GET', '/api/v1/catalog/folders')
      .then((all) => setFolders(all.filter((f) => f.kind === kind)))
      .catch(() => undefined)
  }, [kind])

  const remove = async (item: CatalogItem) => {
    if (!window.confirm(t('c.deleteConfirm'))) return
    try {
      await api('DELETE', `/api/v1/catalog/items/${item.id}`)
      reload()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  return (
    <div>
      <div className="section-head">
        <h2>{kind === 'service' ? t('c.services') : t('c.materials')}</h2>
        <span className="button-row">
          <a
            className="button ghost auto"
            href={`/api/v1/catalog/export.csv?kind=${kind}`}
            download
          >
            {t('cc.export')}
          </a>
          {canWrite && !importing ? (
            <button type="button" className="button ghost auto" onClick={() => setImporting(true)}>
              {t('cc.import')}
            </button>
          ) : null}
          {canWrite && !editing ? (
            <button type="button" className="button primary auto" onClick={() => setEditing('new')}>
              {kind === 'service' ? t('c.newService') : t('c.newMaterial')}
            </button>
          ) : null}
        </span>
      </div>
      {importing ? (
        <CatalogImport kind={kind} onImported={reload} onClose={() => setImporting(false)} />
      ) : null}
      {editing ? (
        <ItemForm
          kind={kind}
          item={editing === 'new' ? null : editing}
          units={units}
          folders={folders}
          onDone={() => {
            setEditing(null)
            reload()
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      <div className="row filters">
        <input
          type="search"
          className="search"
          aria-label={t('c.search')}
          placeholder={t('c.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {folders.length > 1 ? (
          <select
            className="select"
            aria-label={t('c.folder')}
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
          >
            <option value="">{t('c.allFolders')}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.itemCount})
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <FormError>{error}</FormError>
      {!items ? <p className="muted">{t('common.loading')}</p> : null}
      {items && !items.length ? <p className="muted">{t('c.empty')}</p> : null}
      {items?.length ? (
        <ul className="list">
          {items.map((item) => (
            <li key={item.id} className="list-row">
              <span>
                <strong>{item.shortText}</strong>
                {item.source === 'datanorm' ? (
                  <span className="tag ok">{t('c.fromDatanorm')}</span>
                ) : null}
                <span className="muted block">
                  {[
                    item.articleNo,
                    item.supplierName,
                    `${t('c.vk')} ${formatCents(item.priceCents)} ${t('c.perUnit')} ${item.unit.symbol}`,
                    item.costCents ? `${t('c.ek')} ${formatCents(item.costCents)}` : null,
                    item.laborHours && item.laborHours !== '0.00'
                      ? `${formatQuantity(item.laborHours)} ${t('c.hours')}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {canWrite ? (
                <span className="actions">
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => setEditing(item)}
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    type="button"
                    className="button ghost icon danger"
                    aria-label={`${t('common.delete')}: ${item.shortText}`}
                    onClick={() => remove(item)}
                  >
                    ✕
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

interface ComponentInput {
  kind: (typeof COST_KINDS)[number]
  description: string
  quantity: string
  unitId: string
  cost: string
  markup: string
}

function ItemForm({
  kind,
  item,
  units,
  folders,
  onDone,
  onCancel,
}: {
  kind: 'service' | 'material'
  item: CatalogItem | null
  units: UnitSummary[]
  folders: CatalogFolder[]
  onDone: () => void
  onCancel: () => void
}) {
  const [fields, setFields] = useState({
    shortText: item?.shortText ?? '',
    longText: item?.longText ?? '',
    unitId:
      item?.unit.id ??
      units.find((u) => u.symbol === (kind === 'service' ? 'm²' : 'Stk.'))?.id ??
      '',
    folderId: item?.folderId ?? '',
    articleNo: item?.articleNo ?? '',
    manufacturer: item?.manufacturer ?? '',
    cost: item?.costCents && !item.components.length ? centsToInput(item.costCents) : '',
    markup: item && !item.components.length ? formatInputNumber(item.markupPercent) : '',
    price: '',
  })
  const [components, setComponents] = useState<ComponentInput[]>(
    item?.components.map((c) => ({
      kind: c.kind,
      description: c.description ?? '',
      quantity: formatInputNumber(c.quantity),
      unitId: c.unit?.id ?? '',
      cost: centsToInput(c.unitCostCents),
      markup: formatInputNumber(c.markupPercent),
    })) ?? [],
  )
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set = (key: keyof typeof fields) => (e: { target: { value: string } }) =>
    setFields((f) => ({ ...f, [key]: e.target.value }))
  const isTime = (unitId: string) =>
    ['min', 'Std'].includes(units.find((u) => u.id === unitId)?.symbol ?? '')

  const save = async () => {
    setError(null)
    setFieldErrors({})
    const money = (value: string, label: string) => {
      const cents = parseEuro(value)
      if (Number.isNaN(cents)) throw new Error(`${label}: ${t('doc.invalidAmount')}`)
      return cents
    }
    let body: Record<string, unknown>
    try {
      const cost = money(fields.cost, t('c.cost'))
      const price = money(fields.price, t('c.price'))
      body = {
        ...(item ? {} : { kind }),
        shortText: fields.shortText,
        longText: fields.longText || null,
        unitId: fields.unitId,
        folderId: fields.folderId || null,
        articleNo: fields.articleNo || null,
        manufacturer: fields.manufacturer || null,
        ...(cost !== null ? { costCents: cost } : {}),
        ...(fields.markup ? { markupPercent: fields.markup } : {}),
        ...(price !== null ? { priceCents: price } : {}),
        components: components.map((c, i) => ({
          kind: c.kind,
          description: c.description || null,
          quantity: c.quantity || '0',
          unitId: c.unitId || null,
          unitCostCents: money(c.cost, `${t('q.calcCost')} (${i + 1})`) ?? 0,
          markupPercent: c.markup || null,
        })),
      }
    } catch (err) {
      setError((err as Error).message)
      return
    }
    setBusy(true)
    try {
      if (item) await api('PATCH', `/api/v1/catalog/items/${item.id}`, body)
      else await api('POST', '/api/v1/catalog/items', body)
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

  const input = (key: keyof typeof fields, label: string, extra: Record<string, string> = {}) => (
    <div className="field">
      <label htmlFor={`ci-${key}`}>{label}</label>
      <input id={`ci-${key}`} value={fields[key]} onChange={set(key)} {...extra} />
      {fieldErrors[key] ? <p className="field-error">{fieldErrors[key]}</p> : null}
    </div>
  )

  return (
    <div className="panel">
      <h2>
        {item ? t('common.edit') : kind === 'service' ? t('c.newService') : t('c.newMaterial')}
      </h2>
      {input('shortText', t('c.shortText'))}
      <div className="field">
        <label htmlFor="ci-longText">{t('c.longText')}</label>
        <textarea
          id="ci-longText"
          className="textarea"
          rows={3}
          value={fields.longText}
          onChange={set('longText')}
        />
      </div>
      <div className="row">
        <SelectField
          label={t('c.unit')}
          name="unitId"
          value={fields.unitId}
          onChange={(v) => setFields((f) => ({ ...f, unitId: v }))}
          options={units.map((u) => ({ value: u.id, label: `${u.symbol} – ${u.name}` }))}
          error={fieldErrors.unitId}
        />
        {folders.length ? (
          <SelectField
            label={t('c.folder')}
            name="folderId"
            value={fields.folderId}
            onChange={(v) => setFields((f) => ({ ...f, folderId: v }))}
            options={[
              { value: '', label: '–' },
              ...folders.map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
        ) : null}
      </div>
      {kind === 'material' ? (
        <div className="row">
          {input('articleNo', t('c.articleNo'))}
          {input('manufacturer', t('c.manufacturer'))}
        </div>
      ) : null}
      {kind === 'service' ? (
        <fieldset className="components">
          <legend>{t('c.components')}</legend>
          <p className="hint">{t('c.componentsHint')}</p>
          <ul className="rows">
            {components.map((c, i) => {
              const change = (patch: Partial<ComponentInput>) =>
                setComponents((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)))
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; order is the identity
                <li key={i} className="row-card">
                  <div className="row">
                    <SelectField
                      label={t('q.calcKind')}
                      name={`kind-${i}`}
                      value={c.kind}
                      onChange={(v) => change({ kind: v as ComponentInput['kind'] })}
                      options={COST_KINDS.map((k) => ({
                        value: k,
                        label: t(`q.kind.${k}` as TextKey),
                      }))}
                    />
                    <div className="field">
                      <label htmlFor={`cc-${i}-d`}>{t('q.calcDescription')}</label>
                      <input
                        id={`cc-${i}-d`}
                        value={c.description}
                        onChange={(e) => change({ description: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="row-with-action">
                    <div className="row four">
                      <div className="field">
                        <label htmlFor={`cc-${i}-q`}>{t('q.calcQuantity')}</label>
                        <input
                          id={`cc-${i}-q`}
                          inputMode="decimal"
                          value={c.quantity}
                          onChange={(e) => change({ quantity: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`cc-${i}-u`}>{t('q.calcUnit')}</label>
                        <select
                          id={`cc-${i}-u`}
                          className="select"
                          value={c.unitId}
                          onChange={(e) => change({ unitId: e.target.value })}
                        >
                          <option value="">–</option>
                          {units.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.symbol}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor={`cc-${i}-c`}>
                          {c.kind === 'labor' && isTime(c.unitId)
                            ? t('q.calcRate')
                            : t('q.calcCost')}
                        </label>
                        <input
                          id={`cc-${i}-c`}
                          inputMode="decimal"
                          value={c.cost}
                          onChange={(e) => change({ cost: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`cc-${i}-m`}>{t('q.calcMarkup')}</label>
                        <input
                          id={`cc-${i}-m`}
                          inputMode="decimal"
                          placeholder={t('q.calcMarkupDefault')}
                          value={c.markup}
                          onChange={(e) => change({ markup: e.target.value })}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="button ghost icon danger"
                      aria-label={t('d.row.remove')}
                      onClick={() => setComponents((all) => all.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            className="button ghost small"
            onClick={() =>
              setComponents((all) => [
                ...all,
                {
                  kind: all.length ? 'material' : 'labor',
                  description: '',
                  quantity: '',
                  unitId: all.length ? '' : (units.find((u) => u.symbol === 'min')?.id ?? ''),
                  cost: '',
                  markup: '',
                },
              ])
            }
          >
            {t('q.calcAddLine')}
          </button>
        </fieldset>
      ) : null}
      {kind === 'material' || !components.length ? (
        <div className="row">
          {kind === 'material' ? input('cost', t('c.cost'), { inputMode: 'decimal' }) : null}
          {kind === 'material'
            ? input('markup', t('c.markup'), {
                inputMode: 'decimal',
                placeholder: t('c.markupHint'),
              })
            : null}
          {input('price', t('c.price'), {
            inputMode: 'decimal',
            placeholder: item
              ? centsToInput(item.priceCents)
              : kind === 'material'
                ? t('c.priceHint')
                : '',
          })}
        </div>
      ) : null}
      <FormError>{error}</FormError>
      <div className="button-row">
        <button type="button" className="button primary auto" disabled={busy} onClick={save}>
          {t('common.save')}
        </button>
        <button type="button" className="button ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

// ---- Kataloge (DATANORM) ----------------------------------------------------------------------

function SupplierCatalogs({ canWrite, units }: { canWrite: boolean; units: UnitSummary[] }) {
  const [catalogs, setCatalogs] = useState<SupplierCatalog[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  const reload = useCallback(() => {
    api<SupplierCatalog[]>('GET', '/api/v1/supplier-catalogs')
      .then(setCatalogs)
      .catch((err: ApiError) => setError(err.message))
  }, [])
  useEffect(reload, [reload])

  const importFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const params = new URLSearchParams({ filename: file.name })
      if (target) params.set('catalogId', target)
      else if (name.trim()) params.set('name', name.trim())
      setResult(await uploadFile<ImportResult>(`/api/v1/supplier-catalogs/import?${params}`, file))
      reload()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (catalog: SupplierCatalog) => {
    if (!window.confirm(t('c.deleteCatalogConfirm'))) return
    try {
      await api('DELETE', `/api/v1/supplier-catalogs/${catalog.id}`)
      reload()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  return (
    <div>
      {canWrite ? (
        <div className="panel">
          <h2>{t('c.import')}</h2>
          <p className="hint">{t('c.importHint')}</p>
          <div className="row">
            {catalogs?.length ? (
              <SelectField
                label={t('c.importTarget')}
                name="target"
                value={target}
                onChange={setTarget}
                options={[
                  { value: '', label: t('c.importNew') },
                  ...catalogs.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            ) : null}
            {!target ? (
              <div className="field">
                <label htmlFor="import-name">{t('c.importName')}</label>
                <input id="import-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            ) : null}
          </div>
          <label className="button primary auto file-button">
            {busy ? t('c.importing') : t('c.importFile')}
            <input
              type="file"
              className="visually-hidden"
              disabled={busy}
              onChange={(e) => {
                importFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
          {result ? (
            <div className="success" role="status">
              <p>
                {result.catalog.name}:{' '}
                {tf('c.imported', {
                  articles: String(result.stats.articles),
                  deleted: String(result.stats.deleted),
                  prices: String(result.stats.prices),
                  texts: String(result.stats.texts),
                  encoding: result.stats.encoding,
                })}
              </p>
              {result.stats.discounts ? (
                <p>{tf('c.importedDiscounts', { count: String(result.stats.discounts) })}</p>
              ) : null}
              {result.stats.discountsWithoutValue ? (
                <p className="hint">
                  {tf('c.discountsWithoutValue', {
                    count: String(result.stats.discountsWithoutValue),
                  })}
                </p>
              ) : null}
              {result.stats.unknownUnits.length ? (
                <p className="warning">
                  {t('c.unknownUnits')} {result.stats.unknownUnits.join(', ')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <FormError>{error}</FormError>

      <h2>{t('c.catalogs')}</h2>
      {catalogs && !catalogs.length ? <p className="muted">{t('c.noCatalogs')}</p> : null}
      {catalogs?.length ? (
        <ul className="list">
          {catalogs.map((c) => (
            <li key={c.id} className={editing === c.id ? undefined : 'list-row'}>
              {editing === c.id ? (
                <CatalogSettings
                  catalog={c}
                  onDone={() => {
                    setEditing(null)
                    reload()
                  }}
                />
              ) : (
                <>
                  <span>
                    <strong>{c.name}</strong>
                    <span className="muted block">
                      {[
                        c.supplier,
                        `${c.articleCount.toLocaleString('de-DE')} ${t('c.articles')}`,
                        c.discountPercent !== '0'
                          ? `${t('c.discount')}: ${formatInputNumber(c.discountPercent)}`
                          : null,
                        c.importedAt
                          ? `${t('c.importedAt')} ${formatDateTime(c.importedAt)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {canWrite ? (
                    <span className="actions">
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => setEditing(c.id)}
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        type="button"
                        className="button ghost icon danger"
                        aria-label={`${t('c.deleteCatalog')}: ${c.name}`}
                        onClick={() => remove(c)}
                      >
                        ✕
                      </button>
                    </span>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {catalogs?.length ? <ArticleSearch canWrite={canWrite} units={units} /> : null}
    </div>
  )
}

function CatalogSettings({ catalog, onDone }: { catalog: SupplierCatalog; onDone: () => void }) {
  const [name, setName] = useState(catalog.name)
  const [discount, setDiscount] = useState(formatInputNumber(catalog.discountPercent))
  const [groups, setGroups] = useState(
    catalog.discounts.map((d) => `${d.discountGroup} = ${formatInputNumber(d.percent)}`).join('\n'),
  )
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setError(null)
    const discounts = groups
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [group, percent] = line.split('=').map((p) => p.trim())
        return { discountGroup: group ?? '', percent: percent ?? '' }
      })
    try {
      await api('PATCH', `/api/v1/supplier-catalogs/${catalog.id}`, {
        name,
        discountPercent: discount || '0',
        discounts,
      })
      onDone()
    } catch (err) {
      const e = err as ApiError
      setError([e.message, ...Object.values(e.fieldErrors ?? {})].join(' '))
    }
  }
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="cat-name">{t('c.importName')}</label>
        <input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cat-discount">{t('c.discount')}</label>
        <input
          id="cat-discount"
          inputMode="decimal"
          value={discount}
          onChange={(e) => setDiscount(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="cat-groups">{t('c.groupDiscounts')}</label>
        <textarea
          id="cat-groups"
          className="textarea"
          rows={3}
          value={groups}
          onChange={(e) => setGroups(e.target.value)}
        />
        <p className="hint">{t('c.groupDiscountsHint')}</p>
      </div>
      <FormError>{error}</FormError>
      <div className="button-row">
        <button type="button" className="button primary auto" onClick={save}>
          {t('common.save')}
        </button>
        <button type="button" className="button ghost" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

const preciseEuro = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

/** EK per unit, with up to 4 decimals (small parts such as screws cost fractions of a cent). */
export function articlePrice(a: SupplierArticle): string {
  const unit = a.unit?.symbol ?? a.unitRaw ?? ''
  return `${t('c.purchase')}: ${preciseEuro.format(Number(a.unitCostCents) / 100)} / ${unit}`
}

function ArticleSearch({ canWrite, units }: { canWrite: boolean; units: UnitSummary[] }) {
  const [query, setQuery] = useState('')
  const [articles, setArticles] = useState<SupplierArticle[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unitFor, setUnitFor] = useState<Record<string, string>>({})

  useEffect(() => {
    if (query.trim().length < 2) {
      setArticles([])
      return
    }
    const timer = setTimeout(() => {
      api<SupplierArticle[]>(
        'GET',
        `/api/v1/supplier-articles?q=${encodeURIComponent(query.trim())}`,
      )
        .then(setArticles)
        .catch((err: ApiError) => setError(err.message))
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const takeOver = async (article: SupplierArticle) => {
    setMessage(null)
    setError(null)
    try {
      await api('POST', '/api/v1/catalog/items/from-supplier', {
        supplierArticleId: article.id,
        ...(unitFor[article.id] ? { unitId: unitFor[article.id] } : {}),
      })
      setMessage(`${article.shortText}: ${t('c.takenOver')}`)
    } catch (err) {
      const e = err as ApiError
      setError([e.message, ...Object.values(e.fieldErrors ?? {})].join(' '))
    }
  }

  return (
    <div className="panel">
      <h2>{t('c.searchArticles')}</h2>
      <input
        type="search"
        className="search"
        aria-label={t('c.searchArticles')}
        placeholder={t('c.searchArticles')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {message ? (
        <p className="success" role="status">
          {message}
        </p>
      ) : null}
      <FormError>{error}</FormError>
      {articles.length ? (
        <ul className="list">
          {articles.map((a) => (
            <li key={a.id} className="list-row">
              <span>
                <strong>{a.shortText}</strong>
                <span className="muted block">
                  {[
                    a.catalogName,
                    a.articleNo,
                    a.ean,
                    `${a.priceKind === 'list' ? t('c.listPrice') : t('c.netPrice')} ${formatCents(Number(a.priceCents))}${
                      a.priceUnit > 1 ? ` ${t('c.per')} ${a.priceUnit}` : ''
                    }`,
                    articlePrice(a),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {a.longText ? <span className="hint pre block">{a.longText}</span> : null}
              </span>
              {canWrite ? (
                <span className="actions">
                  {!a.unit ? (
                    <select
                      className="select"
                      aria-label={`${t('c.unit')} (${a.unitRaw ?? ''})`}
                      value={unitFor[a.id] ?? ''}
                      onChange={(e) => setUnitFor({ ...unitFor, [a.id]: e.target.value })}
                    >
                      <option value="">{a.unitRaw ?? '?'} → …</option>
                      {units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.symbol}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button type="button" className="button ghost small" onClick={() => takeOver(a)}>
                    {t('c.takeOver')}
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
