import type { LoginResponse, Me } from '@opc/schemas'
import { useState } from 'react'
import { api } from '../api'
import { Field, FormError, optional, useForm, value } from '../forms'
import { t } from '../i18n'

export function SetupScreen({ onDone }: { onDone: (me: Me) => void }) {
  const form = useForm(
    (data) =>
      api<Me>('POST', '/api/v1/setup', {
        setupToken: value(data, 'setupToken'),
        company: {
          name: value(data, 'companyName'),
          trade: optional(data, 'trade'),
          street: optional(data, 'street'),
          postalCode: optional(data, 'postalCode'),
          city: optional(data, 'city'),
        },
        admin: {
          displayName: value(data, 'displayName'),
          email: value(data, 'email'),
          password: String(data.get('password') ?? ''),
        },
      }),
    onDone,
  )
  const e = form.fieldErrors
  return (
    <main className="page">
      <form className="card" onSubmit={form.onSubmit} noValidate>
        <h1>{t('setup.title')}</h1>
        <p className="lead">{t('setup.intro')}</p>
        <FormError>{form.error}</FormError>
        <Field
          label={t('setup.token')}
          name="setupToken"
          hint={t('setup.tokenHint')}
          required
          error={e.setupToken}
        />
        <fieldset>
          <legend>{t('setup.company')}</legend>
          <Field
            label={t('setup.companyName')}
            name="companyName"
            autoComplete="organization"
            required
            error={e['company.name']}
          />
          <Field label={t('setup.trade')} name="trade" error={e['company.trade']} />
          <Field
            label={t('setup.street')}
            name="street"
            autoComplete="street-address"
            error={e['company.street']}
          />
          <div className="row">
            <Field
              label={t('setup.postalCode')}
              name="postalCode"
              autoComplete="postal-code"
              inputMode="numeric"
              error={e['company.postalCode']}
            />
            <Field
              label={t('setup.city')}
              name="city"
              autoComplete="address-level2"
              error={e['company.city']}
            />
          </div>
        </fieldset>
        <fieldset>
          <legend>{t('setup.admin')}</legend>
          <Field
            label={t('setup.displayName')}
            name="displayName"
            autoComplete="name"
            required
            error={e['admin.displayName']}
          />
          <Field
            label={t('auth.email')}
            name="email"
            type="email"
            autoComplete="email"
            required
            error={e['admin.email']}
          />
          <Field
            label={t('auth.password')}
            name="password"
            type="password"
            autoComplete="new-password"
            hint={t('auth.passwordHint')}
            required
            error={e['admin.password']}
          />
        </fieldset>
        <button type="submit" className="button primary" disabled={form.busy}>
          {t('setup.submit')}
        </button>
      </form>
    </main>
  )
}

export function LoginScreen({ appName, onDone }: { appName: string; onDone: (me: Me) => void }) {
  // Credentials are kept only for the second step (TOTP); a failed first step uses fresh input.
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null)
  const form = useForm(
    async (data) => {
      const login = credentials ?? {
        email: value(data, 'email'),
        password: String(data.get('password') ?? ''),
      }
      const result = await api<LoginResponse>('POST', '/api/v1/auth/login', {
        ...login,
        ...(credentials ? { totp: value(data, 'totp') } : {}),
      })
      if (result.status === 'totp_required') setCredentials(login)
      return result
    },
    (result) => {
      if (result.status === 'ok') onDone(result.me)
    },
  )
  const needsTotp = credentials !== null
  return (
    <main className="page">
      <form className="card" onSubmit={form.onSubmit} noValidate>
        <h1>{appName}</h1>
        <p className="lead">{t('app.tagline')}</p>
        <h2>{t('auth.title')}</h2>
        <FormError>{form.error}</FormError>
        {needsTotp ? (
          <Field
            label={t('auth.totp')}
            name="totp"
            autoComplete="one-time-code"
            inputMode="numeric"
            required
            error={form.fieldErrors.totp}
          />
        ) : (
          <>
            <Field
              label={t('auth.email')}
              name="email"
              type="email"
              autoComplete="username"
              required
              error={form.fieldErrors.email}
            />
            <Field
              label={t('auth.password')}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              error={form.fieldErrors.password}
            />
          </>
        )}
        <button type="submit" className="button primary" disabled={form.busy}>
          {t('auth.submit')}
        </button>
      </form>
    </main>
  )
}
