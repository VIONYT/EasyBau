import type { ContactDetail } from '@opc/schemas'
import { useEffect, useId, useState } from 'react'
import { type ApiError, apiWithEtag } from '../api'
import { Field, FormError, SelectField, useForm, value } from '../forms'
import { type TextKey, t } from '../i18n'

const TAX_MODES = [
  'standard',
  'reverse_charge_13b',
  'small_business',
  'intra_eu',
  'export',
] as const
const FORMATS = ['', 'zugferd', 'xrechnung_ubl', 'xrechnung_cii'] as const
/** Leitweg-ID: Grobadressierung, optional Feinadressierung, Prüfziffer (KoSIT). */
const LEITWEG_ID = /^\d{2,12}(-[A-Za-z0-9]{1,30})?-\d{2}$/

const nullable = (data: FormData, name: string) => value(data, name) || null

/**
 * Kontakt bearbeiten: name, invoice address, tax case and the e-invoice data (format, Leitweg-ID,
 * e-mail for e-invoices). They are frozen into each invoice when it is finalized.
 */
export function ContactEditor({
  id,
  canWrite,
  onSaved,
  onClose,
}: {
  id: string
  canWrite: boolean
  onSaved: (contact: ContactDetail) => void
  onClose: () => void
}) {
  const [contact, setContact] = useState<{ data: ContactDetail; etag: string | null } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const headingId = useId()
  useEffect(() => {
    setContact(null)
    setSaved(false)
    apiWithEtag<ContactDetail>('GET', `/api/v1/contacts/${id}`)
      .then(setContact)
      .catch((err: ApiError) => setLoadError(err.message))
  }, [id])

  const form = useForm(
    async (data) => {
      const current = contact as { data: ContactDetail; etag: string | null }
      const main = current.data.addresses.find((a) => a.kind === 'main')
      const others = current.data.addresses
        .filter((a) => a !== main)
        .map(({ id: _, ...rest }) => rest)
      const buyerReference = nullable(data, 'buyerReference')
      return apiWithEtag<ContactDetail>(
        'PATCH',
        `/api/v1/contacts/${id}`,
        {
          ...(current.data.kind === 'organization'
            ? { organizationName: value(data, 'organizationName') }
            : { firstName: nullable(data, 'firstName'), lastName: nullable(data, 'lastName') }),
          taxMode: value(data, 'taxMode'),
          vatId: nullable(data, 'vatId'),
          buyerReference,
          einvoiceEmail: nullable(data, 'einvoiceEmail'),
          einvoiceFormat: nullable(data, 'einvoiceFormat'),
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
            ...others,
          ],
        },
        current.etag,
      )
    },
    (result) => {
      setContact(result)
      setSaved(true)
      onSaved(result.data)
    },
  )

  if (loadError) return <FormError>{loadError}</FormError>
  if (!contact) return <p className="muted">{t('common.loading')}</p>
  const c = contact.data
  const main = c.addresses.find((a) => a.kind === 'main')
  const leitwegInvalid = !!c.buyerReference && !LEITWEG_ID.test(c.buyerReference)
  return (
    <section className="panel contact-editor" aria-labelledby={headingId}>
      <div className="panel-head">
        <h2 id={headingId}>
          {c.displayName}
          {c.number ? <span className="muted"> · {c.number}</span> : null}
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
          )}

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

          <h3>{t('contacts.tax')}</h3>
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
    </section>
  )
}
