import type { InvitationInfo, LoginResponse, Me } from '@easybau/schemas'
import { Button } from '@easybau/ui'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Field, FormError, optional, useForm } from '../forms'
import { t } from '../i18n'

/** Accepting an invitation: /einladung#<token> (the token stays in the fragment, never in server logs). */
export function InvitationScreen({
  onDone,
  onLogin,
}: {
  onDone: (me: Me) => void
  onLogin: () => void
}) {
  const token = window.location.hash.slice(1)
  const [info, setInfo] = useState<InvitationInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false)

  useEffect(() => {
    api<InvitationInfo>('POST', '/api/v1/invitations/lookup', { token })
      .then(setInfo)
      .catch((err: Error) => setError(err.message))
  }, [token])

  const form = useForm(
    (data) =>
      api<LoginResponse>('POST', '/api/v1/invitations/accept', {
        token,
        displayName: optional(data, 'displayName'),
        password: String(data.get('password') ?? ''),
      }),
    (result) => {
      window.history.replaceState(null, '', '/')
      if (result.status === 'ok') onDone(result.me)
      else setNeedsSecondFactor(true)
    },
  )

  return (
    <main className="page">
      <div className="card">
        <h1>{t('invitation.title')}</h1>
        <FormError>{error}</FormError>
        {needsSecondFactor ? (
          <>
            <p role="status">{t('invitation.loginNow')}</p>
            <Button type="button" variant="primary" width="natural" onClick={onLogin}>
              {t('auth.submit')}
            </Button>
          </>
        ) : null}
        {info && !needsSecondFactor ? (
          <form onSubmit={form.onSubmit} noValidate>
            <p className="lead">
              {t('invitation.intro')} <strong>{info.tenantName}</strong> · {info.roleName}
            </p>
            <p className="muted">{info.email}</p>
            {info.existingAccount ? <p>{t('invitation.existing')}</p> : null}
            <FormError>{form.error}</FormError>
            {!info.existingAccount ? (
              <Field
                label={t('setup.displayName')}
                name="displayName"
                autoComplete="name"
                defaultValue={info.displayName ?? ''}
                required
                error={form.fieldErrors.displayName}
              />
            ) : null}
            <Field
              label={t('auth.password')}
              name="password"
              type="password"
              autoComplete={info.existingAccount ? 'current-password' : 'new-password'}
              hint={info.existingAccount ? undefined : t('auth.passwordHint')}
              required
              error={form.fieldErrors.password}
            />
            <Button type="submit" variant="primary" width="natural" disabled={form.busy}>
              {t('invitation.accept')}
            </Button>
          </form>
        ) : null}
      </div>
    </main>
  )
}
