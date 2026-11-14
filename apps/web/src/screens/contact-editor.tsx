import type { ContactDetail, ContactSummary, Page, PaymentTerm } from '@opc/schemas'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api, apiWithEtag } from '../api'
import { Field, FormError, SelectField, TextArea, useForm, value } from '../forms'
import { type TextKey, t } from '../i18n'

const TAX_MODES = [
  'standard',
  'reverse_charge_13b',
  'small_business',
  'intra_eu',
  'export',
] as const
const FORMATS = ['', 'zugferd', 'xrechnung_ubl', 'xrechnung_cii'] as const
const CHANNEL_KINDS = ['email', 'phone', 'mobile', 'fax'] as const
const CHANNEL_LABELS = ['work', 'private', 'other'] as const
/** Leitweg-ID: Grobadressierung, optional Feinadressierung, Prüfziffer (KoSIT). */
const LEITWEG_ID = /^\d{2,12}(-[A-Za-z0-9]{1,30})?-\d{2}$/

const nullable = (data: FormData, name: string) => value(data, name) || null

type Channel = Omit<ContactDetail['channels'][number], 'id'>
type Address = Omit<ContactDetail['addresses'][number], 'id'>
const emptyBilling = (): Address => ({
  kind: 'billing',
  recipientBlock: null,
  street: null,
  streetExtra: null,
  postalCode: null,
  city: null,
  countryCode: 'DE',
})

/**
 * Kontakt bearbeiten (P2.9): Name, Anschrift, abweichender Rechnungsempfänger, E-Mail/Telefon,
 * Zahlungsbedingung, Steuerfall, E-Rechnungsdaten, Ansprechpartner, Projekte, Archivieren.
 * Invoice data are frozen into each invoice when it is finalized.
 */
export function ContactEditor({
  id,
  canWrite,
  canReadSettings,
  onSaved,
  onClose,
  onOpenProject,
  onOpenContact,
}: {
  id: string
  canWrite: boolean
  canReadSettings?: boolean
  onSaved: (contact: ContactDetail) => void
  onClose: () => void
  onOpenProject?: (projectId: string) => void
  onOpenContact?: (contactId: string) => void
}) {
  const [contact, setContact] = useState<{ data: ContactDetail; etag: string | null } | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [billing, setBilling] = useState<Address | null>(null)
  const [terms, setTerms] = useState<PaymentTerm[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const headingId = useId()

  const apply = useCallback((result: { data: ContactDetail; etag: string | null }) => {
    setContact(result)
    setChannels(result.data.channels.map(({ id: _, ...c }) => c))
    const b = result.data.addresses.find((a) => a.kind === 'billing')
    setBilling(b ? (({ id: _, ...rest }) => rest)(b) : null)
  }, [])
  const reload = useCallback(
    () =>
      apiWithEtag<ContactDetail>('GET', `/api/v1/contacts/${id}`)
        .then(apply)
        .catch((err: ApiError) => setLoadError(err.message)),
    [id, apply],
  )
  useEffect(() => {
    setContact(null)
    setSaved(false)
    void reload()
  }, [reload])
  useEffect(() => {
    if (!canReadSettings) return
    api<PaymentTerm[]>('GET', '/api/v1/settings/payment-terms')
      .then(setTerms)
      .catch(() => undefined)
  }, [canReadSettings])

  const form = useForm(
    async (data) => {
      const current = contact as { data: ContactDetail; etag: string | null }
      const main = current.data.addresses.find((a) => a.kind === 'main')
      const others = current.data.addresses
        .filter((a) => a.kind !== 'main' && a.kind !== 'billing')
        .map(({ id: _, ...rest }) => rest)
      const person = current.data.kind === 'person'
      return apiWithEtag<ContactDetail>(
        'PATCH',
        `/api/v1/contacts/${id}`,
        {
          ...(person
            ? {
                salutation: nullable(data, 'salutation'),
                title: nullable(data, 'title'),
                firstName: nullable(data, 'firstName'),
                lastName: nullable(data, 'lastName'),
              }
            : { organizationName: value(data, 'organizationName') }),
          website: nullable(data, 'website'),
          color: value(data, 'useColor') ? value(data, 'color') : null,
          description: nullable(data, 'description'),
          ...(canReadSettings ? { paymentTermId: nullable(data, 'paymentTermId') } : {}),
          taxMode: value(data, 'taxMode'),
          vatId: nullable(data, 'vatId'),
          buyerReference: nullable(data, 'buyerReference'),
          creditorNumber: nullable(data, 'creditorNumber'),
          einvoiceEmail: nullable(data, 'einvoiceEmail'),
          einvoiceFormat: nullable(data, 'einvoiceFormat'),
          channels: channels.filter((c) => c.value.trim()),
          addresses: [
            {
              kind: 'main',
              recipientBlock: main?.recipientBlock ?? null,
              street: nullable(data, 'street'),
              streetExtra: nullable(data, 'streetExtra'),
              postalCode: nullable(data, 'postalCode'),
              city: nullable(data, 'city'),
              countryCode: (value(data, 'countryCode') || 'DE').toUpperCase(),
            },
            ...(billing ? [{ ...billing, countryCode: billing.countryCode.toUpperCase() }] : []),
            ...others,
          ],
        },
        current.etag,
      )
    },
    (result) => {
      apply(result)
      setSaved(true)
      onSaved(result.data)
    },
  )

  if (loadError) return <FormError>{loadError}</FormError>
  if (!contact) return <p className="muted">{t('common.loading')}</p>
  const c = contact.data
  const main = c.addresses.find((a) => a.kind === 'main')
  const leitwegInvalid = !!c.buyerReference && !LEITWEG_ID.test(c.buyerReference)
  const mapQuery = [main?.street, main?.postalCode, main?.city].filter(Boolean).join(' ')
  const setChannel = (index: number, patch: Partial<Channel>) =>
    setChannels(channels.map((ch, i) => (i === index ? { ...ch, ...patch } : ch)))
  const archive = async () => {
    setActionError(null)
    try {
      await api('POST', `/api/v1/contacts/${id}/${c.archived ? 'unarchive' : 'archive'}`, {})
      const result = await apiWithEtag<ContactDetail>('GET', `/api/v1/contacts/${id}`)
      apply(result)
      onSaved(result.data)
    } catch (err) {
      setActionError((err as ApiError).message)
    }
  }

  return (
    <section className="panel contact-editor" aria-labelledby={headingId}>
      <div className="panel-head">
        <h2 id={headingId}>
          {c.displayName}
          {c.number ? <span className="muted"> · {c.number}</span> : null}
          {c.archived ? <span className="badge"> {t('contacts.archived')}</span> : null}
        </h2>
        <button type="button" className="button ghost auto" onClick={onClose}>
          {t('contacts.close')}
        </button>
      </div>
      <form
        key={`${c.id}-${contact.etag}`}
        className="stack"
        onSubmit={(e) => {
          setSaved(false)
          return form.onSubmit(e)
        }}
        noValidate
      >
        <FormError>{form.error}</FormError>
        {saved ? (
          <p className="success" role="status">
            {t('contacts.saved')}
          </p>
        ) : null}
        <fieldset disabled={!canWrite || form.busy}>
          {c.kind === 'organization' ? (
            <Field
              label={t('contacts.organizationName')}
              name="organizationName"
              required
              defaultValue={c.organizationName ?? ''}
              error={form.fieldErrors.organizationName}
            />
          ) : (
            <>
              <div className="row">
                <Field
                  label={t('contacts.salutation')}
                  name="salutation"
                  defaultValue={c.salutation ?? ''}
                />
                <Field label={t('contacts.title')} name="title" defaultValue={c.title ?? ''} />
              </div>
              <div className="row">
                <Field
                  label={t('contacts.firstName')}
                  name="firstName"
                  defaultValue={c.firstName ?? ''}
                  error={form.fieldErrors.firstName}
                />
                <Field
                  label={t('contacts.lastName')}
                  name="lastName"
                  defaultValue={c.lastName ?? ''}
                  error={form.fieldErrors.lastName}
                />
              </div>
            </>
          )}

          <h3>{t('contacts.channels')}</h3>
          {channels.map((ch, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
            <div key={index} className="channel-row">
              <div className="field">
                <label htmlFor={`${headingId}-ck-${index}`}>{t('contacts.channel.kind')}</label>
                <select
                  id={`${headingId}-ck-${index}`}
                  value={ch.kind}
                  onChange={(e) => setChannel(index, { kind: e.target.value as Channel['kind'] })}
                >
                  {CHANNEL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`contacts.channel.${k}` as TextKey)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${headingId}-cv-${index}`}>{t('contacts.channel.value')}</label>
                <input
                  id={`${headingId}-cv-${index}`}
                  type={ch.kind === 'email' ? 'email' : 'tel'}
                  value={ch.value}
                  aria-invalid={form.fieldErrors[`channels.${index}.value`] ? true : undefined}
                  onChange={(e) => setChannel(index, { value: e.target.value })}
                />
                {form.fieldErrors[`channels.${index}.value`] ? (
                  <p className="field-error">{form.fieldErrors[`channels.${index}.value`]}</p>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor={`${headingId}-cl-${index}`}>{t('contacts.channel.label')}</label>
                <select
                  id={`${headingId}-cl-${index}`}
                  value={ch.label}
                  onChange={(e) => setChannel(index, { label: e.target.value as Channel['label'] })}
                >
                  {CHANNEL_LABELS.map((l) => (
                    <option key={l} value={l}>
                      {t(`contacts.channel.label.${l}` as TextKey)}
                    </option>
                  ))}
                </select>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={ch.isPrimary}
                  onChange={(e) =>
                    setChannels(
                      channels.map((other, i) =>
                        i === index
                          ? { ...other, isPrimary: e.target.checked }
                          : other.kind === ch.kind && e.target.checked
                            ? { ...other, isPrimary: false }
                            : other,
                      ),
                    )
                  }
                />
                <span>{t('contacts.channel.primary')}</span>
              </label>
              <button
                type="button"
                className="button ghost small"
                onClick={() => setChannels(channels.filter((_, i) => i !== index))}
              >
                {t('contacts.channel.remove')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button ghost small"
            onClick={() =>
              setChannels([
                ...channels,
                {
                  kind: 'email',
                  value: '',
                  label: 'work',
                  isPrimary: !channels.some((ch) => ch.kind === 'email'),
                },
              ])
            }
          >
            {t('contacts.channel.add')}
          </button>

          <h3>{t('contacts.address')}</h3>
          <Field
            label={t('contacts.street')}
            name="street"
            autoComplete="street-address"
            defaultValue={main?.street ?? ''}
          />
          <Field
            label={t('contacts.streetExtra')}
            name="streetExtra"
            defaultValue={main?.streetExtra ?? ''}
          />
          <div className="row">
            <Field
              label={t('contacts.postalCode')}
              name="postalCode"
              autoComplete="postal-code"
              inputMode="numeric"
              defaultValue={main?.postalCode ?? ''}
            />
            <Field
              label={t('contacts.city')}
              name="city"
              autoComplete="address-level2"
              defaultValue={main?.city ?? ''}
            />
          </div>
          <Field
            label={t('contacts.country')}
            name="countryCode"
            hint={t('contacts.countryHint')}
            defaultValue={main?.countryCode ?? 'DE'}
            error={form.fieldErrors['addresses.0.countryCode']}
          />
          {mapQuery ? (
            <a
              href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(mapQuery)}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t('projects.map')}
            </a>
          ) : null}

          <label className="check">
            <input
              type="checkbox"
              checked={billing !== null}
              onChange={(e) => setBilling(e.target.checked ? emptyBilling() : null)}
            />
            <span>{t('contacts.billing')}</span>
          </label>
          {billing ? (
            <div className="stack billing-address">
              <p className="hint">{t('contacts.billingHint')}</p>
              <div className="field">
                <label htmlFor={`${headingId}-rb`}>{t('contacts.recipientBlock')}</label>
                <textarea
                  id={`${headingId}-rb`}
                  rows={3}
                  value={billing.recipientBlock ?? ''}
                  onChange={(e) =>
                    setBilling({ ...billing, recipientBlock: e.target.value || null })
                  }
                />
              </div>
              {(
                [
                  ['street', 'contacts.street'],
                  ['streetExtra', 'contacts.streetExtra'],
                  ['postalCode', 'contacts.postalCode'],
                  ['city', 'contacts.city'],
                  ['countryCode', 'contacts.country'],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="field">
                  <label htmlFor={`${headingId}-b-${key}`}>{t(label)}</label>
                  <input
                    id={`${headingId}-b-${key}`}
                    value={billing[key] ?? ''}
                    onChange={(e) =>
                      setBilling({
                        ...billing,
                        [key]: key === 'countryCode' ? e.target.value : e.target.value || null,
                      })
                    }
                  />
                </div>
              ))}
            </div>
          ) : null}

          <h3>{t('contacts.more')}</h3>
          <Field
            label={t('contacts.website')}
            name="website"
            defaultValue={c.website ?? ''}
            error={form.fieldErrors.website}
          />
          <div className="row">
            <label className="check">
              <input type="checkbox" name="useColor" value="1" defaultChecked={Boolean(c.color)} />
              <span>{t('contacts.color')}</span>
            </label>
            <input
              type="color"
              name="color"
              aria-label={t('contacts.colorValue')}
              defaultValue={c.color ?? '#0f4c5c'}
            />
          </div>
          <TextArea
            label={t('contacts.description')}
            name="description"
            defaultValue={c.description ?? ''}
          />

          <h3>{t('contacts.tax')}</h3>
          {canReadSettings ? (
            <SelectField
              label={t('contacts.paymentTerm')}
              name="paymentTermId"
              defaultValue={c.paymentTermId ?? ''}
              options={[
                { value: '', label: t('contacts.paymentTermDefault') },
                ...terms.map((term) => ({ value: term.id, label: term.name })),
              ]}
            />
          ) : null}
          <SelectField
            label={t('doc.taxMode')}
            name="taxMode"
            defaultValue={c.taxMode}
            options={TAX_MODES.map((m) => ({ value: m, label: t(`doc.taxMode.${m}` as TextKey) }))}
          />
          <Field
            label={t('contacts.vatId')}
            name="vatId"
            hint={t('contacts.vatIdHint')}
            defaultValue={c.vatId ?? ''}
            error={form.fieldErrors.vatId}
          />

          <h3>{t('contacts.einvoice')}</h3>
          <p className="hint">{t('contacts.einvoiceHint')}</p>
          <SelectField
            label={t('contacts.einvoiceFormat')}
            name="einvoiceFormat"
            defaultValue={c.einvoiceFormat ?? ''}
            options={FORMATS.map((f) => ({
              value: f,
              label: t(`contacts.einvoiceFormat.${f || 'auto'}` as TextKey),
            }))}
          />
          <Field
            label={t('contacts.buyerReference')}
            name="buyerReference"
            hint={
              leitwegInvalid ? t('contacts.buyerReferenceOther') : t('contacts.buyerReferenceHint')
            }
            defaultValue={c.buyerReference ?? ''}
            error={form.fieldErrors.buyerReference}
          />
          <Field
            label={t('contacts.creditorNumber')}
            name="creditorNumber"
            inputMode="numeric"
            hint={t('contacts.creditorNumberHint')}
            defaultValue={c.creditorNumber ?? ''}
            error={form.fieldErrors.creditorNumber}
          />
          <Field
            label={t('contacts.einvoiceEmail')}
            name="einvoiceEmail"
            type="email"
            hint={t('contacts.einvoiceEmailHint')}
            defaultValue={c.einvoiceEmail ?? ''}
            error={form.fieldErrors.einvoiceEmail}
          />
          {canWrite ? (
            <button type="submit" className="button primary auto">
              {t('common.save')}
            </button>
          ) : null}
        </fieldset>
      </form>

      <ContactLinks contact={c} canWrite={canWrite} onChanged={reload} onOpen={onOpenContact} />

      {c.projects.length ? (
        <>
          <h3>{t('contacts.projects')}</h3>
          <ul className="list">
            {c.projects.map((p) => (
              <li key={p.id} className="list-link">
                <a
                  href={`/projekte/${p.id}`}
                  onClick={(e) => {
                    if (!onOpenProject) return
                    e.preventDefault()
                    onOpenProject(p.id)
                  }}
                >
                  <strong>
                    {p.number ? `${p.number} · ` : ''}
                    {p.name}
                  </strong>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <FormError>{actionError}</FormError>
      {canWrite ? (
        <div className="button-row">
          <button type="button" className="button ghost auto" onClick={archive}>
            {t(c.archived ? 'contacts.unarchive' : 'contacts.archive')}
          </button>
        </div>
      ) : null}
    </section>
  )
}

/**
 * Ansprechpartner: persons linked to an organization (with role), or the organizations of a
 * person.
 */
function ContactLinks({
  contact,
  canWrite,
  onChanged,
  onOpen,
}: {
  contact: ContactDetail
  canWrite: boolean
  onChanged: () => Promise<void>
  onOpen?: ((contactId: string) => void) | undefined
}) {
  const id = useId()
  const [adding, setAdding] = useState(false)
  const [candidates, setCandidates] = useState<ContactSummary[]>([])
  const [query, setQuery] = useState('')
  const [choice, setChoice] = useState('')
  const [role, setRole] = useState('')
  const [error, setError] = useState<string | null>(null)
  const other = contact.kind === 'organization' ? 'person' : 'organization'
  useEffect(() => {
    if (!adding) return
    const timer = setTimeout(() => {
      api<Page<ContactSummary>>(
        'GET',
        `/api/v1/contacts?kind=${other}&limit=50&q=${encodeURIComponent(query)}`,
      )
        .then((page) => setCandidates(page.items))
        .catch(() => undefined)
    }, 200)
    return () => clearTimeout(timer)
  }, [adding, other, query])
  const run = async (call: () => Promise<unknown>) => {
    setError(null)
    try {
      await call()
      await onChanged()
      setAdding(false)
      setChoice('')
      setRole('')
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  // Links are stored person → organization.
  const link = (otherId: string) =>
    contact.kind === 'person'
      ? api('POST', `/api/v1/contacts/${contact.id}/links`, {
          organizationId: otherId,
          role: role || null,
        })
      : api('POST', `/api/v1/contacts/${otherId}/links`, {
          organizationId: contact.id,
          role: role || null,
        })

  return (
    <div className="contact-links">
      <h3 id={`${id}-title`}>
        {t(
          contact.kind === 'organization'
            ? 'contacts.links.persons'
            : 'contacts.links.organizations',
        )}
      </h3>
      {contact.links.length ? (
        <ul className="list">
          {contact.links.map((l) => (
            <li key={l.contactId} className="list-row">
              <span>
                <button type="button" className="link-button" onClick={() => onOpen?.(l.contactId)}>
                  {l.displayName}
                </button>
                {l.role ? <span className="muted"> · {l.role}</span> : null}
              </span>
              {canWrite ? (
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() =>
                    run(() => api('DELETE', `/api/v1/contacts/${contact.id}/links/${l.contactId}`))
                  }
                >
                  {t('contacts.links.remove')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('contacts.links.none')}</p>
      )}
      {canWrite && !adding ? (
        <button type="button" className="button ghost small" onClick={() => setAdding(true)}>
          {t(
            contact.kind === 'organization'
              ? 'contacts.links.addPerson'
              : 'contacts.links.addOrganization',
          )}
        </button>
      ) : null}
      {adding ? (
        <div className="stack">
          <div className="field">
            <label htmlFor={`${id}-q`}>{t('contacts.links.search')}</label>
            <input
              id={`${id}-q`}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-choice`}>
              {t(
                contact.kind === 'organization'
                  ? 'contacts.kind.person'
                  : 'contacts.kind.organization',
              )}
            </label>
            <select id={`${id}-choice`} value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">{t('ev.choose')}</option>
              {candidates
                .filter((cand) => !contact.links.some((l) => l.contactId === cand.id))
                .map((cand) => (
                  <option key={cand.id} value={cand.id}>
                    {cand.displayName}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-role`}>{t('contacts.links.role')}</label>
            <input
              id={`${id}-role`}
              value={role}
              placeholder={t('contacts.links.rolePlaceholder')}
              onChange={(e) => setRole(e.target.value)}
            />
          </div>
          <div className="button-row">
            <button
              type="button"
              className="button primary auto"
              disabled={!choice}
              onClick={() => run(() => link(choice))}
            >
              {t('contacts.links.save')}
            </button>
            <button type="button" className="button ghost auto" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      <FormError>{error}</FormError>
    </div>
  )
}
