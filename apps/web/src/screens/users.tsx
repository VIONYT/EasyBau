import type { InvitationSummary, InviteResponse, MemberSummary, RoleSummary } from '@opc/schemas'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { Field, FormError, optional, useForm, value } from '../forms'
import { t } from '../i18n'

/** Benutzerverwaltung: members, roles, invitations (permission users.manage). */
export function Users() {
  const [roles, setRoles] = useState<RoleSummary[]>([])
  const [members, setMembers] = useState<MemberSummary[] | null>(null)
  const [invitations, setInvitations] = useState<InvitationSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)

  const reload = useCallback(() => {
    Promise.all([
      api<RoleSummary[]>('GET', '/api/v1/roles'),
      api<MemberSummary[]>('GET', '/api/v1/users'),
      api<InvitationSummary[]>('GET', '/api/v1/invitations'),
    ])
      .then(([r, m, i]) => {
        setRoles(r)
        setMembers(m)
        setInvitations(i)
      })
      .catch((err: Error) => setError(err.message))
  }, [])
  useEffect(reload, [reload])

  const act = async (action: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    setError(null)
    try {
      await action()
      reload()
    } catch (err) {
      setError((err as ApiError).message)
    }
  }

  const invite = useForm(
    (data) =>
      api<InviteResponse>('POST', '/api/v1/invitations', {
        email: value(data, 'email'),
        displayName: optional(data, 'displayName'),
        roleKey: value(data, 'roleKey'),
      }),
    (result) => {
      setLink(result.acceptUrl)
      reload()
    },
  )

  return (
    <section aria-labelledby="users-title">
      <h1 id="users-title">{t('users.title')}</h1>
      <FormError>{error}</FormError>
      {!members ? <p className="muted">{t('common.loading')}</p> : null}
      {members ? (
        <ul className="list">
          {members.map((m) => (
            <li key={m.userId} className="list-row">
              <span>
                <strong>
                  {m.displayName}
                  {m.isSelf ? ` (${t('users.you')})` : ''}
                </strong>
                <br />
                <span className="muted">
                  {m.email} · {m.totpEnabled || m.webauthnCount ? t('users.mfa') : t('users.noMfa')}
                </span>
              </span>
              {m.isSelf ? (
                <span className="muted">{m.role.name}</span>
              ) : (
                <span className="actions">
                  <RoleSelect
                    roles={roles}
                    value={m.role.key}
                    onChange={(roleKey) =>
                      act(() => api('PATCH', `/api/v1/users/${m.userId}`, { roleKey }))
                    }
                  />
                  {m.totpEnabled || m.webauthnCount ? (
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() =>
                        act(
                          () => api('POST', `/api/v1/users/${m.userId}/reset-mfa`),
                          t('users.resetMfaConfirm'),
                        )
                      }
                    >
                      {t('users.resetMfa')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button ghost danger"
                    onClick={() =>
                      act(
                        () => api('DELETE', `/api/v1/users/${m.userId}`),
                        t('users.removeConfirm'),
                      )
                    }
                  >
                    {t('users.remove')}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="panel">
        <h2>{t('users.invite')}</h2>
        <form className="stack" onSubmit={invite.onSubmit} noValidate>
          <FormError>{invite.error}</FormError>
          <Field
            label={t('auth.email')}
            name="email"
            type="email"
            required
            error={invite.fieldErrors.email}
          />
          <Field
            label={t('users.inviteName')}
            name="displayName"
            error={invite.fieldErrors.displayName}
          />
          <RoleField roles={roles} error={invite.fieldErrors.roleKey} />
          <button type="submit" className="button primary" disabled={invite.busy}>
            {t('users.inviteSend')}
          </button>
        </form>
        {link ? <InviteLink link={link} /> : null}
      </div>

      {invitations.length ? (
        <div className="panel">
          <h2>{t('users.openInvitations')}</h2>
          <ul className="list">
            {invitations.map((i) => (
              <li key={i.id} className="list-row">
                <span>
                  <strong>{i.email}</strong>
                  <br />
                  <span className="muted">
                    {i.role.name} · {t('users.validUntil')} {formatDateTime(i.expiresAt, 'date')}
                  </span>
                </span>
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => act(() => api('DELETE', `/api/v1/invitations/${i.id}`))}
                >
                  {t('users.revoke')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function RoleSelect({
  roles,
  value,
  onChange,
}: {
  roles: RoleSummary[]
  value: string
  onChange: (key: string) => void
}) {
  return (
    <select
      className="select"
      aria-label={t('users.role')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {roles.map((r) => (
        <option key={r.key} value={r.key}>
          {r.name}
        </option>
      ))}
    </select>
  )
}

function RoleField({ roles, error }: { roles: RoleSummary[]; error?: string | undefined }) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{t('users.role')}</label>
      <select id={id} name="roleKey" className="select" defaultValue="team_member">
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name}
          </option>
        ))}
      </select>
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  )
}

function InviteLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="stack" role="status">
      <p>{t('users.inviteLink')}</p>
      <code className="secret">{link}</code>
      <button
        type="button"
        className="button ghost"
        onClick={async () => {
          await navigator.clipboard.writeText(link).catch(() => undefined)
          setCopied(true)
        }}
      >
        {copied ? t('users.copied') : t('users.copy')}
      </button>
    </div>
  )
}
