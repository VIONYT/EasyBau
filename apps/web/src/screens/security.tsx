import type { Me, SecurityOverview, TotpSetupResponse } from '@opc/schemas'
import { useCallback, useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { Field, FormError, useForm, value } from '../forms'
import { t } from '../i18n'
import { QrCode } from '../qr'
import { MySignatureCard } from '../signature'
import { registerKey, webauthnSupported } from '../webauthn'
import { EmailVerificationCard } from './account'

const formatDate = (iso: string) => formatDateTime(iso)

/** Own security settings: authenticator app (TOTP), security keys / passkeys, password. */
export function Security({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [overview, setOverview] = useState<SecurityOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api<SecurityOverview>('GET', '/api/v1/auth/security')
      .then(setOverview)
      .catch((err: Error) => setError(err.message))
  }, [])
  useEffect(reload, [reload])
  const changed = () => {
    reload()
    onChanged()
  }

  return (
    <section aria-labelledby="security-title">
      <h1 id="security-title">{t('security.title')}</h1>
      {me.twoFactorSetupRequired ? (
        <p className="notice inline" role="status">
          {t('security.required')}
        </p>
      ) : null}
      <FormError>{error}</FormError>
      {overview ? (
        <>
          <SecurityKeys overview={overview} onChanged={changed} />
          <TotpCard enabled={overview.totpEnabled} onChanged={changed} />
          <MySignatureCard />
          <EmailVerificationCard me={me} />
          <PasswordCard />
        </>
      ) : (
        <p className="muted">{t('common.loading')}</p>
      )}
    </section>
  )
}

function SecurityKeys({
  overview,
  onChanged,
}: {
  overview: SecurityOverview
  onChanged: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const form = useForm(async (data) => {
    await registerKey(value(data, 'keyName') || 'Sicherheitsschlüssel')
  }, onChanged)
  const remove = async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      await api('DELETE', `/api/v1/auth/webauthn/credentials/${id}`)
      onChanged()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusyId(null)
    }
  }
  return (
    <div className="panel">
      <h2>{t('security.keys')}</h2>
      <p className="muted">{t('security.keysIntro')}</p>
      <FormError>{error}</FormError>
      {overview.credentials.length ? (
        <ul className="list">
          {overview.credentials.map((c) => (
            <li key={c.id} className="list-row">
              <span>
                <strong>{c.name}</strong>
                <br />
                <span className="muted">
                  {c.lastUsedAt
                    ? `${t('security.keyLastUsed')}: ${formatDate(c.lastUsedAt)}`
                    : t('security.keyNeverUsed')}
                </span>
              </span>
              <button
                type="button"
                className="button ghost"
                disabled={busyId === c.id}
                onClick={() => remove(c.id)}
              >
                {t('security.keyRemove')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('security.keysEmpty')}</p>
      )}
      {webauthnSupported() ? (
        <form className="stack" onSubmit={form.onSubmit} noValidate>
          <FormError>{form.error}</FormError>
          <Field
            label={t('security.keyName')}
            name="keyName"
            hint={t('security.keyNamePlaceholder')}
          />
          <button type="submit" className="button primary" disabled={form.busy}>
            {t('security.keyAdd')}
          </button>
          {form.busy ? <p className="hint">{t('auth.keyHint')}</p> : null}
        </form>
      ) : (
        <p className="muted">{t('security.unsupported')}</p>
      )}
    </div>
  )
}

function TotpCard({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const start = async () => {
    setStartError(null)
    try {
      setSetup(await api<TotpSetupResponse>('POST', '/api/v1/auth/totp/setup'))
    } catch (err) {
      setStartError((err as ApiError).message)
    }
  }
  const enable = useForm(
    (data) => api('POST', '/api/v1/auth/totp/enable', { code: value(data, 'code') }),
    () => {
      setSetup(null)
      onChanged()
    },
  )
  const disable = useForm(
    (data) =>
      api('POST', '/api/v1/auth/totp/disable', {
        password: String(data.get('password') ?? ''),
        code: value(data, 'code'),
      }),
    onChanged,
  )
  return (
    <div className="panel">
      <h2>
        {t('security.totp')}{' '}
        <span className={`badge ${enabled ? 'badge--ready' : 'badge--loading'}`}>
          {enabled ? t('security.totpOn') : t('security.totpOff')}
        </span>
      </h2>
      {!enabled && !setup ? (
        <>
          <FormError>{startError}</FormError>
          <button type="button" className="button ghost" onClick={start}>
            {t('security.totpStart')}
          </button>
        </>
      ) : null}
      {setup ? (
        <form className="stack" onSubmit={enable.onSubmit} noValidate>
          <p>{t('security.totpScan')}</p>
          <QrCode value={setup.uri} label={t('security.totp')} />
          <code className="secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          <FormError>{enable.error}</FormError>
          <Field
            label={t('security.totpConfirm')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            error={enable.fieldErrors.code}
          />
          <button type="submit" className="button primary" disabled={enable.busy}>
            {t('security.totpEnable')}
          </button>
        </form>
      ) : null}
      {enabled ? (
        <form className="stack" onSubmit={disable.onSubmit} noValidate>
          <FormError>{disable.error}</FormError>
          <Field
            label={t('auth.password')}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <Field
            label={t('security.totpConfirm')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
          <button type="submit" className="button ghost" disabled={disable.busy}>
            {t('security.totpDisable')}
          </button>
        </form>
      ) : null}
    </div>
  )
}

function PasswordCard() {
  const [saved, setSaved] = useState(false)
  const form = useForm(
    (data) =>
      api('POST', '/api/v1/auth/password', {
        currentPassword: String(data.get('currentPassword') ?? ''),
        newPassword: String(data.get('newPassword') ?? ''),
      }),
    () => setSaved(true),
  )
  return (
    <div className="panel">
      <h2>{t('security.password')}</h2>
      <form className="stack" onSubmit={form.onSubmit} noValidate>
        <FormError>{form.error}</FormError>
        {saved ? (
          <p className="success" role="status">
            {t('security.saved')}
          </p>
        ) : null}
        <Field
          label={t('security.currentPassword')}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          error={form.fieldErrors.currentPassword}
        />
        <Field
          label={t('security.newPassword')}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          hint={t('auth.passwordHint')}
          required
          error={form.fieldErrors.newPassword}
        />
        <button type="submit" className="button ghost" disabled={form.busy}>
          {t('common.save')}
        </button>
      </form>
    </div>
  )
}
