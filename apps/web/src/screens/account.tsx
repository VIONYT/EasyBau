import type {
  EmailChangeInfo,
  EmailChangeRequested,
  EmailVerificationRequested,
  Me,
  PasswordResetInfo,
  PasswordResetRequested,
} from '@easybau/schemas'
import { useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
import { Field, FormError, useForm, value } from '../forms'
import { t, tf } from '../i18n'

/**
 * Konto (P2.10): Passwort vergessen, neues Passwort über den Link (/passwort-zuruecksetzen#…),
 * E-Mail-Bestätigung (/email-bestaetigen#…). The token stays in the URL fragment, so it never
 * reaches server logs or the Referer header.
 */

/** „Passwort vergessen?“ on the login screen: the answer is the same for every address. */
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [result, setResult] = useState<PasswordResetRequested | null>(null)
  const form = useForm(
    (data) =>
      api<PasswordResetRequested>('POST', '/api/v1/auth/password-reset/request', {
        email: value(data, 'email'),
      }),
    setResult,
  )
  return (
    <>
      <h2>{t('account.forgot.title')}</h2>
      {result ? (
        <p className="notice inline" role="status">
          {t(result.emailEnabled ? 'account.forgot.sent' : 'account.forgot.noEmail')}
        </p>
      ) : (
        <form onSubmit={form.onSubmit} noValidate>
          <p className="hint">{t('account.forgot.intro')}</p>
          <FormError>{form.error}</FormError>
          <Field
            label={t('auth.email')}
            name="email"
            type="email"
            autoComplete="username"
            required
            error={form.fieldErrors.email}
          />
          <button type="submit" className="button primary" disabled={form.busy}>
            {t('account.forgot.submit')}
          </button>
        </form>
      )}
      <button type="button" className="button ghost full" onClick={onBack}>
        {t('auth.back')}
      </button>
    </>
  )
}

/** Neues Passwort festlegen über den Link aus der E-Mail oder von der Administration. */
export function PasswordResetScreen({
  appName,
  onLogin,
}: {
  appName: string
  onLogin: () => void
}) {
  const token = window.location.hash.slice(1)
  const [info, setInfo] = useState<PasswordResetInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [mismatch, setMismatch] = useState(false)
  useEffect(() => {
    api<PasswordResetInfo>('POST', '/api/v1/auth/password-reset/lookup', { token })
      .then(setInfo)
      .catch((err: ApiError) => setError(err.message))
  }, [token])
  const form = useForm(
    async (data) => {
      const password = String(data.get('password') ?? '')
      if (password !== String(data.get('repeat') ?? '')) {
        setMismatch(true)
        throw new Error(t('account.reset.mismatch'))
      }
      setMismatch(false)
      return api('POST', '/api/v1/auth/password-reset/confirm', { token, password })
    },
    () => {
      // Forget the token in the address bar and the history.
      window.history.replaceState(null, '', '/')
      setDone(true)
    },
  )
  return (
    <main className="page">
      <div className="card">
        <h1>{appName}</h1>
        <h2>{t('account.reset.title')}</h2>
        <FormError>{error}</FormError>
        {done ? (
          <>
            <p className="success" role="status">
              {t('account.reset.done')}
            </p>
            <button type="button" className="button primary" onClick={onLogin}>
              {t('auth.submit')}
            </button>
          </>
        ) : info ? (
          <form onSubmit={form.onSubmit} noValidate>
            <p>
              {info.displayName} · <span className="muted">{info.email}</span>
            </p>
            <FormError>{form.error}</FormError>
            <input
              type="email"
              name="username"
              autoComplete="username"
              value={info.email}
              readOnly
              hidden
            />
            <Field
              label={t('security.newPassword')}
              name="password"
              type="password"
              autoComplete="new-password"
              hint={t('auth.passwordHint')}
              required
              error={form.fieldErrors.password}
            />
            <Field
              label={t('account.reset.repeat')}
              name="repeat"
              type="password"
              autoComplete="new-password"
              required
              error={mismatch ? t('account.reset.mismatch') : undefined}
            />
            <p className="hint">{t('account.reset.secondFactor')}</p>
            <button type="submit" className="button primary" disabled={form.busy}>
              {t('account.reset.submit')}
            </button>
          </form>
        ) : error ? (
          <button type="button" className="button ghost full" onClick={onLogin}>
            {t('auth.back')}
          </button>
        ) : (
          <p className="muted">{t('common.loading')}</p>
        )}
      </div>
    </main>
  )
}

/** E-Mail-Bestätigung über den Link; works signed in or not. */
export function EmailVerifyScreen({
  appName,
  onContinue,
}: {
  appName: string
  onContinue: () => void
}) {
  const [state, setState] = useState<'busy' | 'done' | string>('busy')
  useEffect(() => {
    const token = window.location.hash.slice(1)
    window.history.replaceState(null, '', '/')
    api('POST', '/api/v1/auth/email/verify', { token })
      .then(() => setState('done'))
      .catch((err: ApiError) => setState(err.message))
  }, [])
  return (
    <main className="page">
      <div className="card">
        <h1>{appName}</h1>
        <h2>{t('account.verify.title')}</h2>
        {state === 'busy' ? <p className="muted">{t('common.loading')}</p> : null}
        {state === 'done' ? (
          <p className="success" role="status">
            {t('account.verify.done')}
          </p>
        ) : null}
        {state !== 'busy' && state !== 'done' ? <FormError>{state}</FormError> : null}
        {state !== 'busy' ? (
          <button type="button" className="button primary" onClick={onContinue}>
            {t('account.verify.continue')}
          </button>
        ) : null}
      </div>
    </main>
  )
}

/** Neue E-Mail-Adresse bestätigen über den Link an die neue Adresse; works signed in or not. */
export function EmailChangeScreen({
  appName,
  onContinue,
}: {
  appName: string
  onContinue: () => void
}) {
  const [token] = useState(() => window.location.hash.slice(1))
  const [info, setInfo] = useState<EmailChangeInfo | null>(null)
  const [state, setState] = useState<'busy' | 'ready' | 'done' | string>('busy')
  useEffect(() => {
    window.history.replaceState(null, '', '/')
    api<EmailChangeInfo>('POST', '/api/v1/auth/email/change/lookup', { token })
      .then((result) => {
        setInfo(result)
        setState('ready')
      })
      .catch((err: ApiError) => setState(err.message))
  }, [token])
  const confirm = () => {
    setState('busy')
    api('POST', '/api/v1/auth/email/change/confirm', { token })
      .then(() => setState('done'))
      .catch((err: ApiError) => setState(err.message))
  }
  const failed = state !== 'busy' && state !== 'ready' && state !== 'done'
  return (
    <main className="page">
      <div className="card">
        <h1>{appName}</h1>
        <h2>{t('account.change.title')}</h2>
        {state === 'busy' ? <p className="muted">{t('common.loading')}</p> : null}
        {state === 'ready' && info ? (
          <>
            <p>
              {tf('account.change.confirmText', {
                name: info.displayName,
                old: info.oldEmail,
                new: info.newEmail,
              })}
            </p>
            <button type="button" className="button primary" onClick={confirm}>
              {t('account.change.confirm')}
            </button>
          </>
        ) : null}
        {state === 'done' ? (
          <p className="success" role="status">
            {tf('account.change.done', { email: info?.newEmail ?? '' })}
          </p>
        ) : null}
        {failed ? <FormError>{state}</FormError> : null}
        {state === 'done' || failed ? (
          <button type="button" className="button primary" onClick={onContinue}>
            {t('account.verify.continue')}
          </button>
        ) : null}
      </div>
    </main>
  )
}

/** Sicherheit: change the own address (current password, link to the new address). */
function EmailChangeForm({ onChanged }: { onChanged: () => void }) {
  const [result, setResult] = useState<EmailChangeRequested | null>(null)
  const form = useForm(
    async (data) =>
      api<EmailChangeRequested>('POST', '/api/v1/auth/email/change', {
        newEmail: value(data, 'newEmail'),
        currentPassword: String(data.get('currentPassword') ?? ''),
      }),
    (res) => {
      setResult(res)
      if (res.changed) onChanged()
    },
  )
  if (result) {
    return (
      <p className="notice inline" role="status">
        {t(result.changed ? 'account.change.changedNow' : 'account.change.linkSent')}
      </p>
    )
  }
  return (
    <form className="stack" onSubmit={form.onSubmit} noValidate>
      <FormError>{form.error}</FormError>
      <Field
        label={t('account.change.newEmail')}
        name="newEmail"
        type="email"
        autoComplete="email"
        required
        error={form.fieldErrors.newEmail}
      />
      <Field
        label={t('security.currentPassword')}
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        error={form.fieldErrors.currentPassword}
      />
      <button type="submit" className="button ghost" disabled={form.busy}>
        {t('account.change.submit')}
      </button>
    </form>
  )
}

/** Sicherheit: status of the e-mail address, „Bestätigungs-E-Mail senden“ and „Ändern“. */
export function EmailVerificationCard({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [changing, setChanging] = useState(false)
  const [result, setResult] = useState<EmailVerificationRequested | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(
        await api<EmailVerificationRequested>('POST', '/api/v1/auth/email/verify-request', {}),
      )
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel">
      <h2>{t('account.email.title')}</h2>
      <p>
        {me.user.email} ·{' '}
        <span className={me.user.emailVerified ? 'success' : 'warning'}>
          {t(me.user.emailVerified ? 'account.email.verified' : 'account.email.unverified')}
        </span>
      </p>
      {me.user.emailVerified ? null : (
        <>
          <p className="hint">{t('account.email.hint')}</p>
          <FormError>{error}</FormError>
          {result ? (
            <p className="notice inline" role="status">
              {t(result.emailEnabled ? 'account.email.sent' : 'account.email.noSmtp')}
            </p>
          ) : (
            <button type="button" className="button ghost" disabled={busy} onClick={send}>
              {t('account.email.send')}
            </button>
          )}
        </>
      )}
      {changing ? (
        <EmailChangeForm onChanged={onChanged} />
      ) : (
        <button type="button" className="button ghost" onClick={() => setChanging(true)}>
          {t('account.change.open')}
        </button>
      )}
    </div>
  )
}
