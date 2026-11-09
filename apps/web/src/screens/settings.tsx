import type {
  Company,
  DatevSettings,
  Me,
  NumberSequence,
  PaymentTerm,
  Surcharges,
  TaxRateSummary,
  TextTemplate,
  UnitSetting,
  WageGroup,
  WorkingDay,
} from '@opc/schemas'
import { COST_KINDS, DOCUMENT_TYPES } from '@opc/schemas/constants'
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import { ApiError, api } from '../api'
import { formatCents, formatInputNumber, parseEuro } from '../format'
import { FormError } from '../forms'
import { type TextKey, t } from '../i18n'
import { SystemSettings } from './system'

type Section =
  | 'company'
  | 'numbers'
  | 'paymentTerms'
  | 'taxRates'
  | 'surcharges'
  | 'wageGroups'
  | 'units'
  | 'workingHours'
  | 'texts'
  | 'filing'
  | 'datev'
  | 'system'

const SECTIONS: { key: Section; label: TextKey }[] = [
  { key: 'company', label: 's.company' },
  { key: 'numbers', label: 's.numbers' },
  { key: 'paymentTerms', label: 's.paymentTerms' },
  { key: 'taxRates', label: 's.taxRates' },
  { key: 'surcharges', label: 's.surcharges' },
  { key: 'wageGroups', label: 's.wageGroups' },
  { key: 'units', label: 's.units' },
  { key: 'workingHours', label: 's.workingHours' },
  { key: 'texts', label: 's.texts' },
  { key: 'filing', label: 's.filing' },
  { key: 'datev', label: 's.datev' },
  { key: 'system', label: 'sys.title' },
]

/** Einstellungen (DESIGN.md §7.4): company, numbering, prices, units, texts, exports, operation. */
export function Settings({ me }: { me: Me }) {
  const [section, setSection] = useState<Section>('company')
  const canWrite = me.permissions.includes('settings.write')
  return (
    <section aria-labelledby="settings-title">
      <h1 id="settings-title">{t('nav.settings')}</h1>
      <div className="field settings-nav">
        <label htmlFor="settings-section">{t('s.section')}</label>
        <select
          id="settings-section"
          className="select"
          value={section}
          onChange={(e) => setSection(e.target.value as Section)}
        >
          {SECTIONS.map((s) => (
            <option key={s.key} value={s.key}>
              {t(s.label)}
            </option>
          ))}
        </select>
      </div>
      <fieldset
        className="settings-body"
        disabled={!canWrite && section !== 'system'}
        key={section}
      >
        {section === 'company' ? (
          <CompanySettings canEdit={me.permissions.includes('tenant.manage')} />
        ) : null}
        {section === 'numbers' ? <NumberSettings /> : null}
        {section === 'paymentTerms' ? <PaymentTermSettings /> : null}
        {section === 'taxRates' ? <TaxRateSettings /> : null}
        {section === 'surcharges' ? <SurchargeSettings /> : null}
        {section === 'wageGroups' ? <WageGroupSettings /> : null}
        {section === 'units' ? <UnitSettings /> : null}
        {section === 'workingHours' ? <WorkingHourSettings /> : null}
        {section === 'texts' ? <TextSettings /> : null}
        {section === 'filing' ? <FilingSettings /> : null}
        {section === 'datev' ? <DatevSettingsForm /> : null}
        {section === 'system' ? <SystemSettings me={me} /> : null}
      </fieldset>
    </section>
  )
}

// ---- Helpers ----------------------------------------------------------------------------------

function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api<T>('GET', path)
      .then(setData)
      .catch((err: ApiError) => setError(err.message))
  }, [path])
  useEffect(reload, [reload])
  return { data, setData, error, setError, reload }
}

/** Runs a save, shows „Gespeichert.“ or the error (incl. field errors). */
function useSave() {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async <T,>(call: () => Promise<T>): Promise<T | null> => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await call()
      setStatus({ ok: true, text: t('s.saved') })
      return result
    } catch (err) {
      const e = err as ApiError
      setStatus({
        ok: false,
        text: [e.message, ...Object.values(e instanceof ApiError ? e.fieldErrors : {})].join(' '),
      })
      return null
    } finally {
      setBusy(false)
    }
  }
  const message = status ? (
    status.ok ? (
      <p className="success" role="status">
        {status.text}
      </p>
    ) : (
      <FormError>{status.text}</FormError>
    )
  ) : null
  return { run, busy, message }
}

function Input({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  inputMode,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email' | 'number' | 'time' | 'date'
  hint?: string
  inputMode?: 'decimal' | 'numeric'
}) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      {children}
    </div>
  )
}

const nullable = (v: string) => (v.trim() === '' ? null : v.trim())

// ---- Firma ------------------------------------------------------------------------------------

const COMPANY_FIELDS: { key: keyof Company; label: TextKey; group: 'base' | 'legal' | 'bank' }[] = [
  { key: 'name', label: 's.c.name', group: 'base' },
  { key: 'legalForm', label: 's.c.legalForm', group: 'base' },
  { key: 'trade', label: 's.c.trade', group: 'base' },
  { key: 'street', label: 's.c.street', group: 'base' },
  { key: 'postalCode', label: 's.c.postalCode', group: 'base' },
  { key: 'city', label: 's.c.city', group: 'base' },
  { key: 'countryCode', label: 's.c.countryCode', group: 'base' },
  { key: 'federalState', label: 's.c.federalState', group: 'base' },
  { key: 'email', label: 's.c.email', group: 'base' },
  { key: 'phone', label: 's.c.phone', group: 'base' },
  { key: 'website', label: 's.c.website', group: 'base' },
  { key: 'vatId', label: 's.c.vatId', group: 'legal' },
  { key: 'taxNumber', label: 's.c.taxNumber', group: 'legal' },
  { key: 'registerCourt', label: 's.c.registerCourt', group: 'legal' },
  { key: 'registerNumber', label: 's.c.registerNumber', group: 'legal' },
  { key: 'managerTitle', label: 's.c.managerTitle', group: 'legal' },
  { key: 'managerName', label: 's.c.managerName', group: 'legal' },
  { key: 'bankName', label: 's.c.bankName', group: 'bank' },
  { key: 'iban', label: 's.c.iban', group: 'bank' },
  { key: 'bic', label: 's.c.bic', group: 'bank' },
]

function CompanySettings({ canEdit }: { canEdit: boolean }) {
  const { data, setData, error } = useResource<Company>('/api/v1/settings/company')
  const save = useSave()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const field = (key: keyof Company) => (
    <Input
      key={key}
      label={t(COMPANY_FIELDS.find((f) => f.key === key)?.label as TextKey)}
      value={(data[key] as string | null) ?? ''}
      onChange={(v) => setData({ ...data, [key]: v })}
      {...(key === 'iban' ? { hint: t('s.c.ibanHint') } : {})}
    />
  )
  const submit = () =>
    save.run(async () => {
      const body = Object.fromEntries(
        COMPANY_FIELDS.map(({ key }) => [
          key,
          key === 'name' || key === 'countryCode'
            ? data[key]
            : (nullable(String(data[key] ?? '')) ??
              (key === 'email' || key === 'iban' ? '' : null)),
        ]),
      )
      setData(await api<Company>('PATCH', '/api/v1/settings/company', body))
    })
  return (
    <fieldset className="plain" disabled={!canEdit}>
      <Panel title={t('s.company')}>
        <div className="row">
          {COMPANY_FIELDS.filter((f) => f.group === 'base').map((f) => field(f.key))}
        </div>
      </Panel>
      <Panel title={t('s.c.legal')}>
        <div className="row">
          {COMPANY_FIELDS.filter((f) => f.group === 'legal').map((f) => field(f.key))}
        </div>
      </Panel>
      <Panel title={t('s.c.bank')}>
        <div className="row">
          {COMPANY_FIELDS.filter((f) => f.group === 'bank').map((f) => field(f.key))}
        </div>
      </Panel>
      <div className="button-row">
        <button type="button" className="button primary auto" disabled={save.busy} onClick={submit}>
          {t('common.save')}
        </button>
        {save.message}
      </div>
    </fieldset>
  )
}

// ---- Nummernkreise ----------------------------------------------------------------------------

function NumberSettings() {
  const { data, setData, error } = useResource<NumberSequence[]>(
    '/api/v1/settings/number-sequences',
  )
  const save = useSave()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const change = (kind: string, patch: Partial<NumberSequence>) =>
    setData(data.map((s) => (s.kind === kind ? { ...s, ...patch } : s)))
  return (
    <Panel title={t('s.numbers')}>
      <p className="hint">{t('s.n.invoiceHint')}</p>
      <ul className="rows">
        {data.map((s) => (
          <li key={s.kind} className="row-card">
            <h3>
              {t(`s.n.kind.${s.kind}` as TextKey)}{' '}
              <span className="muted">
                · {t('s.n.preview')}: {s.preview}
              </span>
            </h3>
            <div className="row four">
              <Input
                label={t('s.n.prefix')}
                value={s.prefix}
                onChange={(v) => change(s.kind, { prefix: v })}
              />
              <Input
                label={t('s.n.next')}
                inputMode="numeric"
                value={String(s.nextValue)}
                onChange={(v) => change(s.kind, { nextValue: Number(v.replace(/\D/g, '')) })}
              />
              <Input
                label={t('s.n.length')}
                inputMode="numeric"
                value={String(s.minLength)}
                onChange={(v) => change(s.kind, { minLength: Number(v.replace(/\D/g, '')) || 1 })}
              />
            </div>
            <div className="button-row">
              <Check
                label={t('s.n.year')}
                checked={s.includeYear}
                onChange={(v) => change(s.kind, { includeYear: v })}
              />
              <Check
                label={t('s.n.reset')}
                checked={s.resetYearly}
                onChange={(v) => change(s.kind, { resetYearly: v })}
              />
              <button
                type="button"
                className="button ghost small"
                disabled={save.busy}
                onClick={() =>
                  save.run(async () => {
                    const { kind, preview: _, ...body } = s
                    const updated = await api<NumberSequence>(
                      'PATCH',
                      `/api/v1/settings/number-sequences/${kind}`,
                      body,
                    )
                    change(kind, updated)
                  })
                }
              >
                {t('common.save')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {save.message}
    </Panel>
  )
}

// ---- Zahlungsziele ----------------------------------------------------------------------------

function PaymentTermSettings() {
  const { data, error, reload } = useResource<PaymentTerm[]>('/api/v1/settings/payment-terms')
  const save = useSave()
  const [draft, setDraft] = useState({ name: '', dueDays: '14', discount: '', discountDays: '' })
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  return (
    <Panel title={t('s.paymentTerms')}>
      <ul className="list">
        {data.map((term) => (
          <li key={term.id} className="list-row">
            <span>
              <strong>{term.name}</strong>
              {term.isDefault ? <span className="tag ok">{t('s.pt.default')}</span> : null}
              <span className="muted block">
                {term.dueDays} Tage
                {term.cashDiscountPercent
                  ? ` · ${formatInputNumber(term.cashDiscountPercent)} % in ${term.cashDiscountDays} Tagen`
                  : ''}
              </span>
            </span>
            <span className="actions">
              {!term.isDefault ? (
                <>
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() =>
                      save
                        .run(() =>
                          api('PATCH', `/api/v1/settings/payment-terms/${term.id}`, {
                            isDefault: true,
                          }),
                        )
                        .then(reload)
                    }
                  >
                    {t('s.pt.makeDefault')}
                  </button>
                  <button
                    type="button"
                    className="button ghost icon danger"
                    aria-label={`${t('common.delete')}: ${term.name}`}
                    onClick={() =>
                      save
                        .run(() => api('DELETE', `/api/v1/settings/payment-terms/${term.id}`))
                        .then(reload)
                    }
                  >
                    ✕
                  </button>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="row four">
        <Input
          label={t('s.pt.name')}
          value={draft.name}
          onChange={(v) => setDraft({ ...draft, name: v })}
        />
        <Input
          label={t('s.pt.days')}
          inputMode="numeric"
          value={draft.dueDays}
          onChange={(v) => setDraft({ ...draft, dueDays: v })}
        />
        <Input
          label={t('s.pt.discount')}
          inputMode="decimal"
          value={draft.discount}
          onChange={(v) => setDraft({ ...draft, discount: v })}
        />
        <Input
          label={t('s.pt.discountDays')}
          inputMode="numeric"
          value={draft.discountDays}
          onChange={(v) => setDraft({ ...draft, discountDays: v })}
        />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button ghost"
          disabled={save.busy}
          onClick={() =>
            save
              .run(() =>
                api('POST', '/api/v1/settings/payment-terms', {
                  name: draft.name,
                  dueDays: Number(draft.dueDays),
                  cashDiscountPercent: nullable(draft.discount),
                  cashDiscountDays: draft.discountDays ? Number(draft.discountDays) : null,
                }),
              )
              .then((r) => {
                if (r) setDraft({ name: '', dueDays: '14', discount: '', discountDays: '' })
                reload()
              })
          }
        >
          {t('s.add')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Steuersätze ------------------------------------------------------------------------------

function TaxRateSettings() {
  const { data, error, reload } = useResource<TaxRateSummary[]>('/api/v1/tax-rates')
  const save = useSave()
  const [draft, setDraft] = useState({ name: '', percent: '', category: 'S' })
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  return (
    <Panel title={t('s.taxRates')}>
      <ul className="list">
        {data.map((rate) => (
          <li key={rate.id} className="list-row">
            <span>
              <strong>{rate.name}</strong>
              {rate.isDefault ? <span className="tag ok">{t('s.pt.default')}</span> : null}
              <span className="muted block">
                {formatInputNumber(rate.percent)} % · {rate.categoryCode}
              </span>
            </span>
            {!rate.isDefault ? (
              <span className="actions">
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() =>
                    save
                      .run(() =>
                        api('PATCH', `/api/v1/settings/tax-rates/${rate.id}`, { isDefault: true }),
                      )
                      .then(reload)
                  }
                >
                  {t('s.pt.makeDefault')}
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="row">
        <Input
          label={t('s.tr.name')}
          value={draft.name}
          onChange={(v) => setDraft({ ...draft, name: v })}
        />
        <Input
          label={t('s.tr.percent')}
          inputMode="decimal"
          value={draft.percent}
          onChange={(v) => setDraft({ ...draft, percent: v })}
        />
        <div className="field">
          <label htmlFor="tr-category">{t('s.tr.category')}</label>
          <select
            id="tr-category"
            className="select"
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          >
            {['S', 'Z', 'E', 'AE', 'K', 'G', 'O'].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button ghost"
          onClick={() =>
            save
              .run(() =>
                api('POST', '/api/v1/settings/tax-rates', {
                  name: draft.name,
                  percent: draft.percent,
                  categoryCode: draft.category,
                }),
              )
              .then(reload)
          }
        >
          {t('s.add')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Zuschläge --------------------------------------------------------------------------------

function SurchargeSettings() {
  const { data, setData, error } = useResource<Surcharges>('/api/v1/settings/surcharges')
  const save = useSave()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  return (
    <Panel title={t('s.surcharges')}>
      <p className="hint">{t('s.sc.hint')}</p>
      <div className="row">
        {COST_KINDS.map((kind) => (
          <Input
            key={kind}
            label={`${t(`q.kind.${kind}` as TextKey)} (%)`}
            inputMode="decimal"
            value={formatInputNumber(data[kind] ?? '0')}
            onChange={(v) => setData({ ...data, [kind]: v })}
          />
        ))}
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={save.busy}
          onClick={() =>
            save.run(async () =>
              setData(
                await api<Surcharges>(
                  'PATCH',
                  '/api/v1/settings/surcharges',
                  Object.fromEntries(COST_KINDS.map((k) => [k, data[k] || '0'])),
                ),
              ),
            )
          }
        >
          {t('common.save')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Lohngruppen ------------------------------------------------------------------------------

function WageGroupSettings() {
  const { data, error, reload } = useResource<WageGroup[]>('/api/v1/settings/wage-groups')
  const save = useSave()
  const [draft, setDraft] = useState({ name: '', cost: '', markup: '' })
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  return (
    <Panel title={t('s.wageGroups')}>
      {data.length ? (
        <ul className="list">
          {data.map((g) => (
            <li key={g.id} className="list-row">
              <span>
                <strong>{g.name}</strong>
                <span className="muted block">
                  {formatCents(g.costPerHourCents)} + {formatInputNumber(g.markupPercent)} % ={' '}
                  {t('s.wg.rate')} {formatCents(g.hourlyRateCents)}
                </span>
              </span>
              <span className="actions">
                <Check
                  label={t('s.wg.active')}
                  checked={g.isActive}
                  onChange={(v) =>
                    save
                      .run(() =>
                        api('PATCH', `/api/v1/settings/wage-groups/${g.id}`, { isActive: v }),
                      )
                      .then(reload)
                  }
                />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <Input
          label={t('s.wg.name')}
          value={draft.name}
          onChange={(v) => setDraft({ ...draft, name: v })}
        />
        <Input
          label={t('s.wg.cost')}
          inputMode="decimal"
          value={draft.cost}
          onChange={(v) => setDraft({ ...draft, cost: v })}
        />
        <Input
          label={t('s.wg.markup')}
          inputMode="decimal"
          value={draft.markup}
          onChange={(v) => setDraft({ ...draft, markup: v })}
        />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button ghost"
          onClick={() =>
            save
              .run(() => {
                const cost = parseEuro(draft.cost)
                if (cost === null || Number.isNaN(cost))
                  throw new ApiError(400, t('doc.invalidAmount'))
                return api('POST', '/api/v1/settings/wage-groups', {
                  name: draft.name,
                  costPerHourCents: cost,
                  markupPercent: draft.markup || '0',
                })
              })
              .then((r) => {
                if (r) setDraft({ name: '', cost: '', markup: '' })
                reload()
              })
          }
        >
          {t('s.add')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Einheiten --------------------------------------------------------------------------------

function UnitSettings() {
  const { data, error, reload } = useResource<UnitSetting[]>('/api/v1/settings/units')
  const save = useSave()
  const [draft, setDraft] = useState({
    symbol: '',
    name: '',
    dimension: 'count',
    unece: '',
    decimals: '2',
  })
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  return (
    <Panel title={t('s.units')}>
      <ul className="list">
        {data.map((u) => (
          <li key={u.id} className="list-row">
            <span>
              <strong>{u.symbol}</strong> {u.name}
              {u.isSystem ? <span className="tag">{t('s.u.system')}</span> : null}
              <span className="muted block">
                {t(`s.u.dim.${u.dimension}` as TextKey)} · {u.uneceCode}
              </span>
            </span>
            <span className="actions">
              <select
                className="select"
                aria-label={`${t('s.u.decimals')}: ${u.symbol}`}
                value={u.decimals}
                onChange={(e) =>
                  save
                    .run(() =>
                      api('PATCH', `/api/v1/settings/units/${u.id}`, {
                        decimals: Number(e.target.value),
                      }),
                    )
                    .then(reload)
                }
              >
                {[0, 1, 2, 3, 4].map((d) => (
                  <option key={d} value={d}>
                    {d} {t('s.u.decimals')}
                  </option>
                ))}
              </select>
              <Check
                label={t('s.u.active')}
                checked={u.isActive}
                onChange={(v) =>
                  save
                    .run(() => api('PATCH', `/api/v1/settings/units/${u.id}`, { isActive: v }))
                    .then(reload)
                }
              />
            </span>
          </li>
        ))}
      </ul>
      <div className="row">
        <Input
          label={t('s.u.symbol')}
          value={draft.symbol}
          onChange={(v) => setDraft({ ...draft, symbol: v })}
        />
        <Input
          label={t('s.u.name')}
          value={draft.name}
          onChange={(v) => setDraft({ ...draft, name: v })}
        />
        <div className="field">
          <label htmlFor="unit-dim">{t('s.u.dimension')}</label>
          <select
            id="unit-dim"
            className="select"
            value={draft.dimension}
            onChange={(e) => setDraft({ ...draft, dimension: e.target.value })}
          >
            {[
              'length',
              'area',
              'volume',
              'mass',
              'time',
              'count',
              'container',
              'lump_sum',
              'power',
            ].map((d) => (
              <option key={d} value={d}>
                {t(`s.u.dim.${d}` as TextKey)}
              </option>
            ))}
          </select>
        </div>
        <Input
          label={t('s.u.unece')}
          value={draft.unece}
          onChange={(v) => setDraft({ ...draft, unece: v })}
        />
        <Input
          label={t('s.u.decimals')}
          inputMode="numeric"
          value={draft.decimals}
          onChange={(v) => setDraft({ ...draft, decimals: v })}
        />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button ghost"
          onClick={() =>
            save
              .run(() =>
                api('POST', '/api/v1/settings/units', {
                  symbol: draft.symbol,
                  name: draft.name,
                  dimension: draft.dimension,
                  uneceCode: draft.unece,
                  decimals: Number(draft.decimals) || 0,
                }),
              )
              .then(reload)
          }
        >
          {t('s.add')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Arbeitszeiten ----------------------------------------------------------------------------

function WorkingHourSettings() {
  const { data, setData, error } = useResource<WorkingDay[]>('/api/v1/settings/working-hours')
  const save = useSave()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const change = (weekday: number, patch: Partial<WorkingDay>) =>
    setData(data.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)))
  return (
    <Panel title={t('s.workingHours')}>
      <p className="hint">{t('s.wh.hint')}</p>
      <ul className="rows">
        {data.map((day) => (
          <li key={day.weekday} className="row-card">
            <h3>{t(`s.wh.day.${day.weekday}` as TextKey)}</h3>
            <div className="row three">
              <Input
                label={t('s.wh.start')}
                type="time"
                value={day.startTime ?? ''}
                onChange={(v) => change(day.weekday, { startTime: v || null })}
              />
              <Input
                label={t('s.wh.end')}
                type="time"
                value={day.endTime ?? ''}
                onChange={(v) => change(day.weekday, { endTime: v || null })}
              />
              <Input
                label={t('s.wh.break')}
                inputMode="numeric"
                value={String(day.breakMinutes)}
                onChange={(v) =>
                  change(day.weekday, { breakMinutes: Number(v.replace(/\D/g, '')) || 0 })
                }
              />
            </div>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={save.busy}
          onClick={() => save.run(() => api('PUT', '/api/v1/settings/working-hours', data))}
        >
          {t('common.save')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Textvorlagen -----------------------------------------------------------------------------

function TextSettings() {
  const { data, error, reload } = useResource<TextTemplate[]>('/api/v1/settings/text-templates')
  const save = useSave()
  const [draft, setDraft] = useState({
    documentType: 'quote',
    placement: 'intro',
    name: '',
    body: '',
    isDefault: true,
  })
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  return (
    <Panel title={t('s.texts')}>
      {data.length ? (
        <ul className="list">
          {data.map((tpl) => (
            <li key={tpl.id} className="list-row">
              <span>
                <strong>{tpl.name}</strong>
                {tpl.isDefault ? <span className="tag ok">{t('s.pt.default')}</span> : null}
                <span className="muted block">
                  {t(`doc.type.${tpl.documentType}` as TextKey) ?? t('doc.invoice.standard')} ·{' '}
                  {tpl.placement === 'intro' ? t('s.t.intro') : t('s.t.closing')}
                </span>
                <span className="hint pre block">{tpl.body}</span>
              </span>
              <span className="actions">
                <button
                  type="button"
                  className="button ghost icon danger"
                  aria-label={`${t('common.delete')}: ${tpl.name}`}
                  onClick={() =>
                    save
                      .run(() => api('DELETE', `/api/v1/settings/text-templates/${tpl.id}`))
                      .then(reload)
                  }
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <h3>{t('s.t.new')}</h3>
      <div className="row">
        <div className="field">
          <label htmlFor="tt-type">{t('s.t.type')}</label>
          <select
            id="tt-type"
            className="select"
            value={draft.documentType}
            onChange={(e) => setDraft({ ...draft, documentType: e.target.value })}
          >
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type === 'invoice' ? t('doc.invoice.standard') : t(`doc.type.${type}` as TextKey)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tt-placement">{t('s.t.placement')}</label>
          <select
            id="tt-placement"
            className="select"
            value={draft.placement}
            onChange={(e) => setDraft({ ...draft, placement: e.target.value })}
          >
            <option value="intro">{t('s.t.intro')}</option>
            <option value="closing">{t('s.t.closing')}</option>
          </select>
        </div>
        <Input
          label={t('s.t.name')}
          value={draft.name}
          onChange={(v) => setDraft({ ...draft, name: v })}
        />
      </div>
      <div className="field">
        <label htmlFor="tt-body">{t('s.t.body')}</label>
        <textarea
          id="tt-body"
          className="textarea"
          rows={4}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
      </div>
      <Check
        label={t('s.t.default')}
        checked={draft.isDefault}
        onChange={(v) => setDraft({ ...draft, isDefault: v })}
      />
      <div className="button-row">
        <button
          type="button"
          className="button ghost"
          onClick={() =>
            save
              .run(() => api('POST', '/api/v1/settings/text-templates', draft))
              .then((r) => {
                if (r) setDraft({ ...draft, name: '', body: '' })
                reload()
              })
          }
        >
          {t('s.add')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Ablage-Ordner ----------------------------------------------------------------------------

function FilingSettings() {
  const { data, setData, error } = useResource<{ folders: string[] }>(
    '/api/v1/settings/filing-template',
  )
  const save = useSave()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  return (
    <Panel title={t('s.filing')}>
      <div className="field">
        <label htmlFor="filing-folders">{t('s.filing')}</label>
        <textarea
          id="filing-folders"
          className="textarea"
          rows={8}
          value={data.folders.join('\n')}
          onChange={(e) => setData({ folders: e.target.value.split('\n') })}
        />
        <p className="hint">{t('s.f.hint')}</p>
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={save.busy}
          onClick={() =>
            save.run(async () =>
              setData(
                await api<{ folders: string[] }>('PUT', '/api/v1/settings/filing-template', {
                  folders: data.folders.map((f) => f.trim()).filter(Boolean),
                }),
              ),
            )
          }
        >
          {t('common.save')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- DATEV ------------------------------------------------------------------------------------

function DatevSettingsForm() {
  const { data, setData, error } = useResource<DatevSettings>('/api/v1/settings/datev')
  const save = useSave()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const revenue = (key: keyof DatevSettings['revenueAccounts'], label: TextKey) => (
    <Input
      label={t(label)}
      inputMode="numeric"
      value={data.revenueAccounts[key] ?? ''}
      onChange={(v) =>
        setData({ ...data, revenueAccounts: { ...data.revenueAccounts, [key]: nullable(v) } })
      }
    />
  )
  return (
    <Panel title={t('s.datev')}>
      <p className="hint">{t('s.d.hint')}</p>
      <div className="row">
        <Input
          label={t('s.d.consultant')}
          inputMode="numeric"
          value={data.consultantNumber ?? ''}
          onChange={(v) => setData({ ...data, consultantNumber: nullable(v) })}
        />
        <Input
          label={t('s.d.client')}
          inputMode="numeric"
          value={data.clientNumber ?? ''}
          onChange={(v) => setData({ ...data, clientNumber: nullable(v) })}
        />
        <div className="field">
          <label htmlFor="datev-chart">{t('s.d.chart')}</label>
          <select
            id="datev-chart"
            className="select"
            value={data.chart}
            onChange={(e) => setData({ ...data, chart: e.target.value as DatevSettings['chart'] })}
          >
            <option value="SKR03">SKR 03</option>
            <option value="SKR04">SKR 04</option>
          </select>
        </div>
        <Input
          label={t('s.d.fiscalYear')}
          inputMode="numeric"
          value={String(data.fiscalYearStartMonth)}
          onChange={(v) => setData({ ...data, fiscalYearStartMonth: Number(v) || 1 })}
        />
        <Input
          label={t('s.d.accountLength')}
          inputMode="numeric"
          value={String(data.accountLength)}
          onChange={(v) => setData({ ...data, accountLength: Number(v) || 4 })}
        />
      </div>
      <div className="row">
        {revenue('standard19', 's.d.revenue19')}
        {revenue('reduced7', 's.d.revenue7')}
        {revenue('reverseCharge', 's.d.revenueRc')}
        {revenue('exempt', 's.d.revenueExempt')}
        <Input
          label={t('s.d.bank')}
          inputMode="numeric"
          value={data.bankAccount ?? ''}
          onChange={(v) => setData({ ...data, bankAccount: nullable(v) })}
        />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={save.busy}
          onClick={() =>
            save.run(async () =>
              setData(await api<DatevSettings>('PUT', '/api/v1/settings/datev', data)),
            )
          }
        >
          {t('common.save')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}
