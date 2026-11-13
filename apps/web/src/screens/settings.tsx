import { checkNumberPattern, formatNumber } from '@opc/domain'
import type {
  BaseInterestRate,
  BusinessArea,
  Company,
  DatevSettings,
  DocumentSettings,
  DunningLevel,
  DunningSettings,
  EmailTemplateSettings,
  HolidayList,
  IncomingMailRun,
  IncomingMailSettings,
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
import { COST_KINDS, DOCUMENT_TYPES, FEDERAL_STATES } from '@opc/schemas/constants'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { ApiError, api, uploadFile } from '../api'
import { formatCents, formatInputNumber, parseEuro } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import { LetterheadEditor } from './letterhead'
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
  | 'documents'
  | 'holidays'
  | 'letterhead'
  | 'filing'
  | 'datev'
  | 'areas'
  | 'mail'
  | 'incomingMail'
  | 'dunning'
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
  { key: 'holidays', label: 's.holidays' },
  { key: 'texts', label: 's.texts' },
  { key: 'documents', label: 's.documents' },
  { key: 'letterhead', label: 'lh.title' },
  { key: 'filing', label: 's.filing' },
  { key: 'datev', label: 's.datev' },
  { key: 'areas', label: 's.areas' },
  { key: 'mail', label: 's.mail' },
  { key: 'incomingMail', label: 's.incomingMail' },
  { key: 'dunning', label: 'sys.dunning' },
  { key: 'system', label: 'sys.title' },
]

/** Einstellungen (DESIGN.md §7.4): company, numbering, prices, units, texts, exports, operation. */
export function Settings({ me, initial }: { me: Me; initial?: string | undefined }) {
  const [section, setSection] = useState<Section>(
    SECTIONS.find((s) => s.key === initial)?.key ?? 'company',
  )
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
        {section === 'documents' ? <DocumentDefaultsForm /> : null}
        {section === 'holidays' ? <HolidaySettings canWrite={canWrite} /> : null}
        {section === 'letterhead' ? <LetterheadEditor canEdit={canWrite} /> : null}
        {section === 'filing' ? <FilingSettings /> : null}
        {section === 'datev' ? <DatevSettingsForm /> : null}
        {section === 'areas' ? <BusinessAreaSettings /> : null}
        {section === 'mail' ? <EmailTemplateForm /> : null}
        {section === 'dunning' ? <DunningSettingsForm /> : null}
        {section === 'incomingMail' ? <IncomingMailForm /> : null}
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
  const field = (key: keyof Company) =>
    key === 'federalState' ? (
      <FederalStateSelect
        key={key}
        value={data.federalState}
        onChange={(federalState) => setData({ ...data, federalState })}
      />
    ) : (
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
          key === 'name' || key === 'countryCode' || key === 'federalState'
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
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const change = (seq: NumberSequence) => setData(data.map((s) => (s.kind === seq.kind ? seq : s)))
  return (
    <Panel title={t('s.numbers')}>
      <p className="hint">{t('s.n.invoiceHint')}</p>
      <p className="hint">{t('s.n.patternHint')}</p>
      <ul className="rows">
        {data.map((s) => (
          <NumberSequenceCard key={s.kind} seq={s} onChange={change} />
        ))}
      </ul>
    </Panel>
  )
}

const NUMBER_TOKENS = ['{Jahr}', '{JJ}', '{Monat}', '{Nummer}'] as const

/** One Nummernkreis: schema with placeholders, live preview of the next number. */
function NumberSequenceCard({
  seq,
  onChange,
}: {
  seq: NumberSequence
  onChange: (seq: NumberSequence) => void
}) {
  const save = useSave()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<NumberSequence>) => onChange({ ...seq, ...patch })
  const problem = checkNumberPattern(seq.pattern)
  const now = new Date()
  const preview = problem
    ? null
    : formatNumber(seq.pattern, seq.nextValue, seq.minLength, {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
      })
  const insert = (token: string) => {
    const el = input.current
    const from = el?.selectionStart ?? seq.pattern.length
    const to = el?.selectionEnd ?? seq.pattern.length
    set({ pattern: seq.pattern.slice(0, from) + token + seq.pattern.slice(to) })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(from + token.length, from + token.length)
    })
  }
  return (
    <li className="row-card">
      <h3>
        {t(`s.n.kind.${seq.kind}` as TextKey)}{' '}
        <span className="muted">
          · {t('s.n.preview')}: <strong>{preview ?? '–'}</strong>
        </span>
      </h3>
      <div className="field">
        <label htmlFor={`${id}-pattern`}>{t('s.n.pattern')}</label>
        <input
          id={`${id}-pattern`}
          ref={input}
          value={seq.pattern}
          maxLength={40}
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => set({ pattern: e.target.value })}
        />
        {problem ? (
          <p className="field-error" id={`${id}-problem`}>
            {problem}
          </p>
        ) : null}
      </div>
      <div className="button-row">
        {NUMBER_TOKENS.map((token) => (
          <button
            key={token}
            type="button"
            className="button ghost small"
            aria-label={`${t('s.n.insert')} ${token}`}
            onClick={() => insert(token)}
          >
            {token}
          </button>
        ))}
      </div>
      <div className="row four">
        <Input
          label={t('s.n.next')}
          inputMode="numeric"
          value={String(seq.nextValue)}
          onChange={(v) => set({ nextValue: Number(v.replace(/\D/g, '')) })}
        />
        <Input
          label={t('s.n.length')}
          inputMode="numeric"
          value={String(seq.minLength)}
          onChange={(v) => set({ minLength: Math.min(Number(v.replace(/\D/g, '')) || 1, 12) })}
        />
      </div>
      <div className="button-row">
        <Check
          label={t('s.n.reset')}
          checked={seq.resetYearly}
          onChange={(v) => set({ resetYearly: v })}
        />
        <button
          type="button"
          className="button ghost small"
          disabled={save.busy || problem !== null}
          onClick={() =>
            save.run(async () => {
              const { kind, preview: _, ...body } = seq
              onChange(
                await api<NumberSequence>(
                  'PATCH',
                  `/api/v1/settings/number-sequences/${kind}`,
                  body,
                ),
              )
            })
          }
        >
          {t('common.save')}
        </button>
      </div>
      {save.message}
    </li>
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
  const expense = (key: keyof DatevSettings['expenseAccounts']) => (
    <Input
      label={t(`s.d.expense.${key}` as TextKey)}
      inputMode="numeric"
      value={data.expenseAccounts[key] ?? ''}
      onChange={(v) =>
        setData({ ...data, expenseAccounts: { ...data.expenseAccounts, [key]: nullable(v) } })
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
      <h3>{t('s.d.incoming')}</h3>
      <p className="hint">{t('s.d.incomingHint')}</p>
      <div className="row">
        {expense('material')}
        {expense('labor')}
        {expense('equipment')}
        {expense('subcontract')}
        {expense('other')}
        {expense('reverseCharge')}
        <Input
          label={t('s.d.creditor')}
          inputMode="numeric"
          value={data.creditorAccount ?? ''}
          onChange={(v) => setData({ ...data, creditorAccount: nullable(v) })}
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

// ---- E-Mail-Vorlagen --------------------------------------------------------------------------

type MailType = (typeof DOCUMENT_TYPES)[number]

function EmailTemplateForm() {
  const { data, setData, error } = useResource<EmailTemplateSettings>(
    '/api/v1/settings/email-templates',
  )
  const save = useSave()
  const [type, setType] = useState<MailType>('invoice')
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const current = data.templates[type]
  const setTemplate = (patch: Partial<{ subject: string; body: string }>) =>
    setData({
      ...data,
      templates: { ...data.templates, [type]: { ...current, ...patch, custom: true } },
    })
  return (
    <Panel title={t('s.mail')}>
      <p className="hint">{t('s.mail.hint')}</p>
      <Input
        label={t('s.mail.bcc')}
        type="email"
        value={data.bcc ?? ''}
        onChange={(v) => setData({ ...data, bcc: nullable(v) })}
      />
      <div className="field">
        <label htmlFor="mail-type">{t('s.mail.type')}</label>
        <select
          id="mail-type"
          className="select"
          value={type}
          onChange={(e) => setType(e.target.value as MailType)}
        >
          {DOCUMENT_TYPES.map((d) => (
            <option key={d} value={d}>
              {t((d === 'invoice' ? 'doc.invoice.standard' : `doc.type.${d}`) as TextKey)}
              {data.templates[d].custom ? ` (${t('s.mail.custom')})` : ''}
            </option>
          ))}
        </select>
      </div>
      <Input
        label={t('s.mail.subject')}
        value={current.subject}
        onChange={(v) => setTemplate({ subject: v })}
      />
      <div className="field">
        <label htmlFor="mail-body">{t('s.mail.body')}</label>
        <textarea
          id="mail-body"
          rows={10}
          value={current.body}
          onChange={(e) => setTemplate({ body: e.target.value })}
        />
        <p className="hint">
          {tf('s.mail.placeholders', { list: data.placeholders.map((p) => `{${p}}`).join(' ') })}
        </p>
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={save.busy}
          onClick={() =>
            save.run(async () => {
              const templates = Object.fromEntries(
                DOCUMENT_TYPES.filter((d) => data.templates[d].custom).map((d) => [
                  d,
                  { subject: data.templates[d].subject, body: data.templates[d].body },
                ]),
              )
              const saved = await api<EmailTemplateSettings>(
                'PUT',
                '/api/v1/settings/email-templates',
                {
                  bcc: data.bcc,
                  templates,
                },
              )
              setData(saved)
            })
          }
        >
          {t('common.save')}
        </button>
        {current.custom ? (
          <button
            type="button"
            className="button ghost auto"
            onClick={() =>
              setData({
                ...data,
                templates: { ...data.templates, [type]: { ...data.defaults[type], custom: false } },
              })
            }
          >
            {t('s.mail.reset')}
          </button>
        ) : null}
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Betriebsbereiche -------------------------------------------------------------------------

function BusinessAreaSettings() {
  const { data, error, reload } = useResource<BusinessArea[]>('/api/v1/business-areas')
  const save = useSave()
  const [name, setName] = useState('')
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  return (
    <Panel title={t('s.areas')}>
      <p className="hint">{t('s.areas.hint')}</p>
      <ul className="list">
        {data.map((area) => (
          <li key={area.id} className="list-row">
            <span>
              <strong>{area.name}</strong>
              {area.archived ? <span className="tag">{t('s.areas.archived')}</span> : null}
            </span>
            <span className="actions">
              <button
                type="button"
                className="button ghost small"
                onClick={() =>
                  save
                    .run(() =>
                      api('PATCH', `/api/v1/business-areas/${area.id}`, {
                        archived: !area.archived,
                      }),
                    )
                    .then(reload)
                }
              >
                {t(area.archived ? 's.areas.restore' : 's.areas.archive')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="row">
        <Input label={t('s.areas.new')} value={name} onChange={setName} />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button ghost"
          disabled={!name.trim()}
          onClick={() =>
            save
              .run(() => api('POST', '/api/v1/business-areas', { name }))
              .then((created) => {
                if (created) setName('')
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

// ---- Mahnungen --------------------------------------------------------------------------------

const DUNNING_STEPS: DunningLevel[] = ['reminder', 'first', 'final']

function DunningSettingsForm() {
  const { data, setData, error } = useResource<DunningSettings>('/api/v1/settings/dunning')
  const save = useSave()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const update = (level: DunningLevel, patch: Partial<DunningSettings[DunningLevel]>) =>
    setData({ ...data, [level]: { ...data[level], ...patch } })
  return (
    <>
      <Panel title={t('sys.dunning')}>
        <p className="hint">{t('sys.dunningHint')}</p>
        {DUNNING_STEPS.map((level) => (
          <DunningStep key={level} level={level} rule={data[level]} onChange={update} />
        ))}
        <Check
          label={t('sys.dunningFlatFee')}
          checked={data.flatFeeBusiness}
          onChange={(v) => setData({ ...data, flatFeeBusiness: v })}
        />
        <div className="button-row">
          <button
            type="button"
            className="button primary auto"
            disabled={save.busy}
            onClick={() =>
              save.run(async () =>
                setData(await api<DunningSettings>('PUT', '/api/v1/settings/dunning', data)),
              )
            }
          >
            {t('common.save')}
          </button>
          {save.message}
        </div>
      </Panel>
      <BaseRateSettings />
    </>
  )
}

function DunningStep({
  level,
  rule,
  onChange,
}: {
  level: DunningLevel
  rule: DunningSettings[DunningLevel]
  onChange: (level: DunningLevel, patch: Partial<DunningSettings[DunningLevel]>) => void
}) {
  const id = useId()
  const [fee, setFee] = useState(formatInputNumber((rule.feeCents / 100).toFixed(2)))
  return (
    <fieldset className="dunning-step">
      <legend>{t(`dun.level.${level}` as TextKey)}</legend>
      <div className="row">
        <Input
          label={t('dun.days')}
          inputMode="numeric"
          value={String(rule.days)}
          onChange={(v) => onChange(level, { days: Number(v) || 0 })}
        />
        <Input
          label={t('dun.fee')}
          inputMode="decimal"
          value={fee}
          onChange={(v) => {
            setFee(v)
            const cents = parseEuro(v)
            if (cents !== null) onChange(level, { feeCents: cents })
          }}
        />
      </div>
      <Check
        label={tf('dun.interest', { points: '5/9' })}
        checked={rule.interest}
        onChange={(v) => onChange(level, { interest: v })}
      />
      <div className="field">
        <label htmlFor={`${id}-text`}>{t('dun.text')}</label>
        <textarea
          id={`${id}-text`}
          rows={4}
          value={rule.text}
          onChange={(e) => onChange(level, { text: e.target.value })}
        />
      </div>
    </fieldset>
  )
}

function BaseRateSettings() {
  const { data, setData, error } = useResource<BaseInterestRate[]>(
    '/api/v1/settings/base-interest-rates',
  )
  const save = useSave()
  const [validFrom, setValidFrom] = useState('')
  const [rate, setRate] = useState('')
  if (error) return <FormError>{error}</FormError>
  if (!data) return null
  return (
    <Panel title={t('sys.baseRates')}>
      <p className="hint">{t('sys.baseRatesHint')}</p>
      <ul className="list entries">
        {data.slice(0, 8).map((r) => (
          <li key={r.id}>
            <span>
              {tf('sys.baseRateLine', {
                date: formatDate(r.validFrom),
                rate: r.ratePercent.replace('.', ','),
              })}
              {r.own ? <span className="muted"> · {t('sys.baseRateOwn')}</span> : null}
            </span>
            {r.own ? (
              <button
                type="button"
                className="button ghost auto"
                onClick={() =>
                  save.run(async () =>
                    setData(
                      await api<BaseInterestRate[]>(
                        'DELETE',
                        `/api/v1/settings/base-interest-rates/${r.id}`,
                      ),
                    ),
                  )
                }
              >
                {t('common.delete')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="row">
        <Input
          label={t('sys.baseRateFrom')}
          type="date"
          value={validFrom}
          onChange={setValidFrom}
        />
        <Input label={t('sys.baseRateValue')} inputMode="decimal" value={rate} onChange={setRate} />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button ghost auto"
          disabled={save.busy || !validFrom || !rate}
          onClick={() =>
            save.run(async () => {
              setData(
                await api<BaseInterestRate[]>('POST', '/api/v1/settings/base-interest-rates', {
                  validFrom,
                  ratePercent: rate,
                }),
              )
              setValidFrom('')
              setRate('')
            })
          }
        >
          {t('sys.baseRateAdd')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

const formatDate = (iso: string) => iso.split('-').reverse().join('.')

function FederalStateSelect({
  value,
  onChange,
}: {
  value: Company['federalState']
  onChange: (value: Company['federalState']) => void
}) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{t('s.c.federalState')}</label>
      <select
        id={id}
        className="select"
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value || null) as Company['federalState'])}
      >
        <option value="">{t('s.c.federalStateNone')}</option>
        {FEDERAL_STATES.map((code) => (
          <option key={code} value={code}>
            {t(`fs.${code}` as TextKey)}
          </option>
        ))}
      </select>
      <p className="hint">{t('s.c.federalStateHint')}</p>
    </div>
  )
}

// ---- Dokumente (P2.11): § 35a, Abschläge, Dateinamen, automatische Anhänge -------------------

const typeLabel = (type: string) =>
  t((type === 'invoice' ? 'doc.invoice.standard' : `doc.type.${type}`) as TextKey)

function DocumentDefaultsForm() {
  const { data, setData, error } = useResource<DocumentSettings>('/api/v1/settings/documents')
  const save = useSave()
  const upload = useSave()
  const [name, setName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const store = () =>
    save.run(async () =>
      setData(
        await api<DocumentSettings>('PUT', '/api/v1/settings/documents', {
          laborShare: data.laborShare,
          progressBillingMode: data.progressBillingMode,
          fileNamePattern: data.fileNamePattern,
          attachments: data.attachments,
        }),
      ),
    )
  const matrix = (row: 'invoice' | 'offer', column: 'person' | 'organization') => (
    <Check
      label={t(column === 'person' ? 'sd.persons' : 'sd.organizations')}
      checked={data.laborShare[row][column]}
      onChange={(v) =>
        setData({
          ...data,
          laborShare: { ...data.laborShare, [row]: { ...data.laborShare[row], [column]: v } },
        })
      }
    />
  )
  const toggleAttachment = (type: string, fileId: string, on: boolean) => {
    const current = data.attachments[type as keyof typeof data.attachments] ?? []
    setData({
      ...data,
      attachments: {
        ...data.attachments,
        [type]: on ? [...current, fileId] : current.filter((id) => id !== fileId),
      },
    })
  }
  const send = (file: File) =>
    upload.run(async () => {
      const label = name.trim() || file.name
      await uploadFile(`/api/v1/settings/attachments?name=${encodeURIComponent(label)}`, file)
      setName('')
      if (fileRef.current) fileRef.current.value = ''
      setData({
        ...(await api<DocumentSettings>('GET', '/api/v1/settings/documents')),
        // keep unsaved changes of the form
        laborShare: data.laborShare,
        progressBillingMode: data.progressBillingMode,
        fileNamePattern: data.fileNamePattern,
        attachments: data.attachments,
      })
    })
  const saveButton = (
    <div className="button-row">
      <button type="button" className="button primary auto" disabled={save.busy} onClick={store}>
        {t('common.save')}
      </button>
      {save.message}
    </div>
  )
  return (
    <>
      <Panel title={t('sd.laborShare')}>
        <p className="hint">{t('sd.laborShareHint')}</p>
        <fieldset className="plain">
          <legend>{t('sd.invoices')}</legend>
          {matrix('invoice', 'person')}
          {matrix('invoice', 'organization')}
        </fieldset>
        <fieldset className="plain">
          <legend>{t('sd.offers')}</legend>
          {matrix('offer', 'person')}
          {matrix('offer', 'organization')}
        </fieldset>
      </Panel>
      <Panel title={t('sd.progress')}>
        <fieldset className="plain">
          <legend className="sr-only">{t('inv.mode')}</legend>
          {(['cumulative', 'individual'] as const).map((mode) => (
            <label key={mode} className="check">
              <input
                type="radio"
                name="progressBillingMode"
                checked={data.progressBillingMode === mode}
                onChange={() => setData({ ...data, progressBillingMode: mode })}
              />
              {t(`inv.mode.${mode}`)}
            </label>
          ))}
        </fieldset>
        <p className="hint">{t('sd.progressHint')}</p>
      </Panel>
      <Panel title={t('sd.fileNames')}>
        <Input
          label={t('sd.pattern')}
          value={data.fileNamePattern}
          onChange={(fileNamePattern) => setData({ ...data, fileNamePattern })}
          hint={tf('sd.patternHint', {
            list: data.placeholders.map((p) => `{${p}}`).join(' '),
            example: data.example,
          })}
        />
        <button
          type="button"
          className="button ghost small"
          onClick={() => setData({ ...data, fileNamePattern: data.defaultFileNamePattern })}
        >
          {t('sd.patternReset')}
        </button>
      </Panel>
      <Panel title={t('sd.attachments')}>
        <p className="hint">{t('sd.attachmentsHint')}</p>
        {data.files.length === 0 ? <p className="muted">{t('sd.noFiles')}</p> : null}
        <ul className="list">
          {data.files.map((file) => (
            <li key={file.id} className="list-row attachment-row">
              <span>
                <strong>{file.name}</strong>{' '}
                <a href={`/api/v1/assets/${file.id}`} target="_blank" rel="noreferrer">
                  {t('sd.view')}
                </a>
              </span>
              <fieldset className="plain attachment-types">
                <legend>{t('sd.attachTo')}</legend>
                {DOCUMENT_TYPES.map((type) => (
                  <Check
                    key={type}
                    label={typeLabel(type)}
                    checked={(data.attachments[type] ?? []).includes(file.id)}
                    onChange={(v) => toggleAttachment(type, file.id, v)}
                  />
                ))}
              </fieldset>
            </li>
          ))}
        </ul>
        <div className="row">
          <Input label={t('sd.uploadName')} value={name} onChange={setName} />
          <div className="field">
            <label htmlFor="attachment-upload">{t('sd.upload')}</label>
            <input
              id="attachment-upload"
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              disabled={upload.busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void send(file)
              }}
            />
          </div>
        </div>
        {upload.message}
      </Panel>
      {saveButton}
    </>
  )
}

// ---- Feiertage (P2.11) -------------------------------------------------------------------------

function HolidaySettings({ canWrite }: { canWrite: boolean }) {
  const [year, setYear] = useState(() => new Date().getFullYear())
  const { data, setData, error } = useResource<HolidayList>(
    `/api/v1/settings/holidays?year=${year}`,
  )
  const save = useSave()
  const [draft, setDraft] = useState({ date: '', name: '' })
  const yearId = useId()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const reload = async () =>
    setData(await api<HolidayList>('GET', `/api/v1/settings/holidays?year=${year}`))
  return (
    <Panel
      title={
        data.federalState
          ? tf('hol.state', { state: t(`fs.${data.federalState}` as TextKey) })
          : t('s.holidays')
      }
    >
      <p className="hint">{t('hol.hint')}</p>
      {data.federalState ? null : <p className="warning">{t('hol.noState')}</p>}
      <div className="field narrow">
        <label htmlFor={yearId}>{t('hol.year')}</label>
        <select
          id={yearId}
          className="select"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 1 + i).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      <ul className="list">
        {data.holidays.map((day) => (
          <li key={`${day.date}-${day.id ?? day.name}`} className="list-row">
            <span>
              <strong className="tabular">
                {new Date(`${day.date}T00:00:00`).toLocaleDateString('de-DE', {
                  weekday: 'short',
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}
              </strong>{' '}
              {day.name}
              {day.custom ? <span className="muted"> · {t('hol.own')}</span> : null}
            </span>
            {day.custom && day.id && canWrite ? (
              <button
                type="button"
                className="button ghost small"
                onClick={() => {
                  if (!window.confirm(t('hol.removeConfirm'))) return
                  void save.run(async () => {
                    await api('DELETE', `/api/v1/settings/holidays/${day.id}`)
                    await reload()
                  })
                }}
              >
                {t('hol.remove')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <h3>{t('hol.add')}</h3>
      <div className="row">
        <Input
          label={t('hol.date')}
          type="date"
          value={draft.date}
          onChange={(date) => setDraft({ ...draft, date })}
        />
        <Input
          label={t('hol.name')}
          value={draft.name}
          onChange={(name) => setDraft({ ...draft, name })}
        />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={save.busy || !draft.date || !draft.name.trim()}
          onClick={() =>
            void save.run(async () => {
              const list = await api<HolidayList>('POST', '/api/v1/settings/holidays', draft)
              setDraft({ date: '', name: '' })
              if (draft.date.startsWith(String(year))) setData(list)
            })
          }
        >
          {t('hol.add')}
        </button>
        {save.message}
      </div>
    </Panel>
  )
}

// ---- Rechnungseingang per E-Mail (P2.4) ---------------------------------------------------------

function IncomingMailForm() {
  const { data, setData, error } = useResource<IncomingMailSettings>(
    '/api/v1/settings/incoming-mail',
  )
  const [password, setPassword] = useState('')
  const save = useSave()
  const fetchNow = useSave()
  if (error) return <FormError>{error}</FormError>
  if (!data) return <p className="muted">{t('common.loading')}</p>
  const run = data.lastRun
  return (
    <Panel title={t('s.incomingMail')}>
      <p className="hint">{t('im.hint')}</p>
      {!data.available ? <p className="warning">{t('im.unavailable')}</p> : null}
      <Check
        label={t('im.enabled')}
        checked={data.enabled}
        onChange={(enabled) => setData({ ...data, enabled })}
      />
      <div className="row">
        <Input
          label={t('im.host')}
          value={data.host ?? ''}
          onChange={(host) => setData({ ...data, host })}
        />
        <Input
          label={t('im.port')}
          type="number"
          inputMode="numeric"
          value={String(data.port)}
          onChange={(port) => setData({ ...data, port: Number(port) || 993 })}
        />
      </div>
      <Check
        label={t('im.secure')}
        checked={data.secure}
        onChange={(secure) => setData({ ...data, secure })}
      />
      <div className="row">
        <Input
          label={t('im.user')}
          value={data.user ?? ''}
          onChange={(user) => setData({ ...data, user })}
        />
        <div className="field">
          <label htmlFor="incoming-mail-password">{t('im.password')}</label>
          <input
            id="incoming-mail-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {data.hasPassword ? <p className="hint">{t('im.passwordStored')}</p> : null}
        </div>
      </div>
      <div className="row">
        <Input
          label={t('im.mailbox')}
          value={data.mailbox}
          onChange={(mailbox) => setData({ ...data, mailbox })}
        />
        <Input
          label={t('im.processed')}
          value={data.processedMailbox ?? ''}
          onChange={(processedMailbox) => setData({ ...data, processedMailbox })}
        />
      </div>
      <p className="hint" role="status">
        {run
          ? `${tf('im.lastRun', {
              at: new Date(run.at).toLocaleString('de-DE'),
              messages: String(run.messages),
              imported: String(run.imported),
              duplicates: String(run.duplicates),
              ignored: String(run.ignored),
              failed: String(run.failed),
            })}${run.error ? ` ${run.error}` : ''}`
          : t('im.never')}
      </p>
      <div className="button-row">
        <button
          type="button"
          className="button primary auto"
          disabled={save.busy}
          onClick={() =>
            save.run(async () => {
              setData(
                await api<IncomingMailSettings>('PUT', '/api/v1/settings/incoming-mail', {
                  enabled: data.enabled,
                  host: nullable(data.host ?? ''),
                  port: data.port,
                  secure: data.secure,
                  user: nullable(data.user ?? ''),
                  ...(password ? { password } : {}),
                  mailbox: data.mailbox || 'INBOX',
                  processedMailbox: nullable(data.processedMailbox ?? ''),
                }),
              )
              setPassword('')
            })
          }
        >
          {t('common.save')}
        </button>
        {data.available ? (
          <button
            type="button"
            className="button ghost auto"
            disabled={fetchNow.busy}
            onClick={() =>
              fetchNow.run(async () => {
                const result = await api<IncomingMailRun>(
                  'POST',
                  '/api/v1/settings/incoming-mail/run',
                  {},
                )
                setData({ ...data, lastRun: result })
              })
            }
          >
            {t('im.run')}
          </button>
        ) : null}
        {save.message}
        {fetchNow.message}
      </div>
    </Panel>
  )
}
