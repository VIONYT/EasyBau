import type { LoginResponse, Me, MfaMethod } from '@opc/schemas'
import { useState } from 'react'
import { api } from '../api'
import { Field, FormError, optional, useForm, value } from '../forms'
import { t } from '../i18n'
import { loginWithKeyAsSecondFactor, loginWithPasskey, webauthnSupported } from '../webauthn'
import { ForgotPassword } from './account'

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
  // After a correct password the server keeps a pending login (HttpOnly cookie) for the 2nd step.
  const [methods, setMethods] = useState<MfaMethod[] | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const [forgot, setForgot] = useState(false)

  const handle = (result: LoginResponse) => {
    if (result.status === 'ok') onDone(result.me)
    else setMethods(result.methods)
  }
  const password = useForm(
    (data) =>
      api<LoginResponse>('POST', '/api/v1/auth/login', {
        email: value(data, 'email'),
        password: String(data.get('password') ?? ''),
      }),
    handle,
  )
  const totp = useForm(
    (data) => api<LoginResponse>('POST', '/api/v1/auth/login/totp', { code: value(data, 'code') }),
    handle,
  )
  const withKey = async (run: () => Promise<LoginResponse>) => {
    setKeyBusy(true)
    setKeyError(null)
    try {
      handle(await run())
    } catch (err) {
      setKeyError((err as Error).message)
    } finally {
      setKeyBusy(false)
    }
  }

  return (
    <main className="page">
      <div className="card">
        <h1>{appName}</h1>
        <p className="lead">{t('app.tagline')}</p>
        {forgot ? (
          <ForgotPassword onBack={() => setForgot(false)} />
        ) : methods ? (
          <>
            <h2>{t('auth.secondFactor')}</h2>
            <p>{t('auth.secondFactorIntro')}</p>
            <FormError>{keyError}</FormError>
            {methods.includes('webauthn') ? (
              <div className="stack">
                <button
                  type="button"
                  className="button primary"
                  disabled={keyBusy}
                  onClick={() => withKey(loginWithKeyAsSecondFactor)}
                >
                  {t('auth.useKey')}
                </button>
                <p className="hint">{t('auth.keyHint')}</p>
              </div>
            ) : null}
            {methods.includes('totp') ? (
              <form onSubmit={totp.onSubmit} noValidate>
                {methods.includes('webauthn') ? <p className="divider">{t('auth.or')}</p> : null}
                <FormError>{totp.error}</FormError>
                <Field
                  label={t('auth.totp')}
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                  error={totp.fieldErrors.code}
                />
                <button type="submit" className="button primary" disabled={totp.busy}>
                  {t('auth.submit')}
                </button>
              </form>
            ) : null}
            <button type="button" className="button ghost full" onClick={() => setMethods(null)}>
              {t('auth.back')}
            </button>
          </>
        ) : (
          <>
            <h2>{t('auth.title')}</h2>
            <form onSubmit={password.onSubmit} noValidate>
              <FormError>{password.error}</FormError>
              <Field
                label={t('auth.email')}
                name="email"
                type="email"
                autoComplete="username webauthn"
                required
                error={password.fieldErrors.email}
              />
              <Field
                label={t('auth.password')}
                name="password"
                type="password"
                autoComplete="current-password"
                required
                error={password.fieldErrors.password}
              />
              <button type="submit" className="button primary" disabled={password.busy}>
                {t('auth.submit')}
              </button>
            </form>
            <button type="button" className="link-button" onClick={() => setForgot(true)}>
              {t('account.forgot.link')}
            </button>
            {webauthnSupported() ? (
              <div className="stack">
                <p className="divider">{t('auth.or')}</p>
                <FormError>{keyError}</FormError>
                <button
                  type="button"
                  className="button ghost full"
                  disabled={keyBusy}
                  onClick={() => withKey(loginWithPasskey)}
                >
                  {t('auth.passkey')}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </main>
  )
}
