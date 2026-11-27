import type { Me, SecurityOverview, TotpSetupResponse } from '@easybau/schemas'
import { Button } from '@easybau/ui'
import { useCallback, useEffect, useState } from 'react'
import { type ApiError, api, downloadFile } from '../api'
import { type ContrastMode, readContrast, saveContrast } from '../contrast'
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
          <EmailVerificationCard me={me} onChanged={onChanged} />
          <PasswordCard />
          <MyDataCard />
          <DisplayCard />
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
              <Button
                type="button"
                variant="ghost"
                width="natural"
                disabled={busyId === c.id}
                onClick={() => remove(c.id)}
              >
                {t('security.keyRemove')}
              </Button>
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
          <Button type="submit" variant="primary" width="natural" disabled={form.busy}>
            {t('security.keyAdd')}
          </Button>
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
          <Button type="button" variant="ghost" width="natural" onClick={start}>
            {t('security.totpStart')}
          </Button>
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
          <Button type="submit" variant="primary" width="natural" disabled={enable.busy}>
            {t('security.totpEnable')}
          </Button>
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
          <Button type="submit" variant="ghost" width="natural" disabled={disable.busy}>
            {t('security.totpDisable')}
          </Button>
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
        <Button type="submit" variant="ghost" width="natural" disabled={form.busy}>
          {t('common.save')}
        </Button>
      </form>
    </div>
  )
}

/** DSGVO Art. 15/20: everything stored about the own login, as a file. */
function MyDataCard() {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="panel">
      <h2>{t('security.myData')}</h2>
      <p className="hint">{t('security.myDataHint')}</p>
      <FormError>{error}</FormError>
      <Button
        type="button"
        variant="ghost"
        width="natural"
        onClick={() =>
          downloadFile('/api/v1/auth/privacy-report').catch((err: ApiError) =>
            setError(err.message),
          )
        }
      >
        {t('security.myDataDownload')}
      </Button>
    </div>
  )
}

/** Darstellung: high contrast for sunlight on the site (stored on this device only). */
function DisplayCard() {
  const [mode, setMode] = useState<ContrastMode>(readContrast)
  return (
    <div className="panel">
      <h2>{t('security.display')}</h2>
      <fieldset className="choices">
        <legend>{t('security.contrast')}</legend>
        {(['system', 'high', 'normal'] as const).map((m) => (
          <label key={m}>
            <input
              type="radio"
              name="contrast"
              checked={mode === m}
              onChange={() => {
                setMode(m)
                saveContrast(m)
              }}
            />
            <span>{t(`security.contrast.${m}`)}</span>
          </label>
        ))}
      </fieldset>
      <p className="hint">{t('security.contrastHint')}</p>
    </div>
  )
}
