import type {
  EmailSettings,
  InvitationSummary,
  InviteResponse,
  MemberSummary,
  RoleSummary,
} from '@opc/schemas'
import { useCallback, useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatDateTime } from '../format'
import { Field, FormError, optional, useForm, value } from '../forms'
import { t, tf } from '../i18n'

/** Default end of a Prüfer access: 30 days from today. */
const inDays = (days: number) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d)
}

/** Benutzerverwaltung: members, roles, invitations (permission users.manage). */
export function Users() {
  const [roles, setRoles] = useState<RoleSummary[]>([])
  const [members, setMembers] = useState<MemberSummary[] | null>(null)
  const [invitations, setInvitations] = useState<InvitationSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [emailQueued, setEmailQueued] = useState(false)
  const [emailEnabled, setEmailEnabled] = useState(false)
  const [inviteRole, setInviteRole] = useState('team_member')
  useEffect(() => {
    api<EmailSettings>('GET', '/api/v1/settings/email')
      .then((s) => setEmailEnabled(s.enabled))
      .catch(() => setEmailEnabled(false))
  }, [])

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
        accessUntil: optional(data, 'accessUntil'),
        sendEmail: data.get('sendEmail') === 'on',
      }),
    (result) => {
      setLink(result.acceptUrl)
      setEmailQueued(result.emailQueued)
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
                {m.validUntil ? (
                  <>
                    <br />
                    <span className={m.expired ? 'warning-text' : 'muted'}>
                      {tf(m.expired ? 'users.accessEnded' : 'users.accessLine', {
                        date: formatDateTime(m.validUntil, 'date'),
                      })}
                    </span>
                  </>
                ) : null}
              </span>
              {m.isSelf ? (
                <span className="muted">{m.role.name}</span>
              ) : (
                <span className="actions">
                  <RoleSelect
                    roles={roles}
                    value={m.role.key}
                    onChange={(roleKey) =>
                      act(() =>
                        api('PATCH', `/api/v1/users/${m.userId}`, {
                          roleKey,
                          // A Prüfer always gets an end date (30 days, changeable below).
                          ...(roleKey === 'auditor' && !m.validUntil
                            ? { validUntil: inDays(30) }
                            : {}),
                        }),
                      )
                    }
                  />
                  {m.validUntil || m.role.key === 'auditor' ? (
                    <input
                      type="date"
                      aria-label={`${t('users.accessUntil')} ${m.displayName}`}
                      defaultValue={m.validUntil ?? ''}
                      onBlur={(e) => {
                        const next = e.target.value || null
                        if (next !== m.validUntil) {
                          void act(() =>
                            api('PATCH', `/api/v1/users/${m.userId}`, { validUntil: next }),
                          )
                        }
                      }}
                    />
                  ) : null}
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
          <RoleField
            roles={roles}
            value={inviteRole}
            onChange={setInviteRole}
            error={invite.fieldErrors.roleKey}
          />
          {inviteRole === 'auditor' ? (
            <Field
              label={t('users.accessUntil')}
              name="accessUntil"
              type="date"
              required
              defaultValue={inDays(30)}
              hint={t('users.accessUntilHint')}
              error={invite.fieldErrors.accessUntil}
            />
          ) : null}
          {emailEnabled ? (
            <label className="check">
              <input type="checkbox" name="sendEmail" defaultChecked />
              {t('users.sendEmail')}
            </label>
          ) : null}
          <button type="submit" className="button primary" disabled={invite.busy}>
            {t('users.inviteSend')}
          </button>
        </form>
        {link ? <InviteLink link={link} /> : null}
        {link && emailQueued ? (
          <p className="success" role="status">
            {t('users.emailSent')}
          </p>
        ) : null}
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
                    {i.accessUntil
                      ? ` · ${tf('users.accessLine', { date: formatDateTime(i.accessUntil, 'date') })}`
                      : ''}
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

function RoleField({
  roles,
  value,
  onChange,
  error,
}: {
  roles: RoleSummary[]
  value: string
  onChange: (key: string) => void
  error?: string | undefined
}) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{t('users.role')}</label>
      <select
        id={id}
        name="roleKey"
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
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
