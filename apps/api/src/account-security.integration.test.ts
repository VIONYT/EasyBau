import type { EmailChangeInfo, EmailChangeRequested, Me } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deviceLabel } from './routes/security-notices.js'
import { base32Decode, hotp, totpStep } from './security/crypto.js'
import {
  PasswordHasher,
  parseStoredHash,
  pepperKeyId,
  unusablePasswordHashes,
} from './security/passwords.js'
import { Client, createHarness, type Harness } from './testing/harness.js'
import { SoftAuthenticator } from './testing/soft-authenticator.js'

/** Konto: eigene E-Mail-Adresse ändern, Sicherheitshinweise (Passwort geändert, neues Gerät). */
describe.skipIf(!process.env.DATABASE_URL)(
  'Konto: E-Mail ändern und Sicherheitshinweise (integration)',
  () => {
    let h: Harness
    let admin: Client
    const PASSWORD = 'ein-sehr-langes-passwort'

    const mails = (kind: string, to: string) =>
      h.adminSql<{ subject: string; body: string }[]>`
      select subject, body_text as body from email_message where kind = ${kind} and to_address = ${to}
      order by created_at`
    async function linkFrom(kind: string, to: string): Promise<string> {
      const rows = await mails(kind, to)
      const match = /#([A-Za-z0-9_-]{43})/.exec(rows.at(-1)?.body ?? '')
      if (!match) throw new Error(`no link in ${kind} mail to ${to}`)
      return match[1] as string
    }

    beforeAll(async () => {
      h = await createHarness({ requireAdminMfa: false, smtp: true })
      admin = new Client(h.app)
      await admin.post('/api/v1/setup', {
        setupToken: h.setupToken,
        company: { name: 'Sicher Bau GmbH' },
        admin: { email: 'chef@sicher.test', password: PASSWORD, displayName: 'Chef' },
      })
    })

    afterAll(async () => {
      await h?.close()
    })

    it('tells the person about a login from a new device, not about the first or a known one', async () => {
      // Setup logged in on the first device: no notice for it.
      expect(await mails('security_notice', 'chef@sicher.test')).toHaveLength(0)
      const login = (c: Client) =>
        c.post(
          '/api/v1/auth/login',
          { email: 'chef@sicher.test', password: PASSWORD },
          {
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15',
          },
        )
      const phone = new Client(h.app)
      expect((await login(phone)).statusCode).toBe(200)
      // The setup session had no device cookie yet: the first login is the first device.
      expect(await mails('security_notice', 'chef@sicher.test')).toHaveLength(0)
      expect((await login(phone)).statusCode).toBe(200)
      expect(await mails('security_notice', 'chef@sicher.test')).toHaveLength(0)

      const laptop = new Client(h.app)
      expect((await login(laptop)).statusCode).toBe(200)
      const notices = await mails('security_notice', 'chef@sicher.test')
      expect(notices).toHaveLength(1)
      expect(notices[0]?.subject).toMatch(/Anmeldung von einem neuen Gerät/)
      expect(notices[0]?.body).toMatch(/Safari auf iOS/)
      const [row] = await h.adminSql<{ n: number }[]>`
      select count(*)::int as n from known_device d join app_user u on u.id = d.user_id
      where u.email = 'chef@sicher.test'`
      expect(row?.n).toBe(2)
      admin = laptop
    })

    it('tells the person when the password was changed', async () => {
      const res = await admin.post('/api/v1/auth/password', {
        currentPassword: PASSWORD,
        newPassword: 'ein-neues-sehr-langes-passwort',
      })
      expect(res.statusCode, res.body).toBe(204)
      const notices = await mails('security_notice', 'chef@sicher.test')
      expect(notices.at(-1)?.subject).toMatch(/Passwort wurde geändert/)
    })

    it('tells the person when a security key or the authenticator app is added or removed', async () => {
      const subjects = async () =>
        (await mails('security_notice', 'chef@sicher.test')).map((m) => m.subject)
      const before = (await subjects()).length

      const key = new SoftAuthenticator('http://localhost:80')
      const options = (await admin.post('/api/v1/auth/webauthn/register/options')).json()
      const created = await admin.post('/api/v1/auth/webauthn/register/verify', {
        response: key.register(options),
        name: 'YubiKey Büro',
      })
      expect(created.statusCode, created.body).toBe(201)
      const { id } = created.json<{ id: string }>()
      expect((await admin.delete(`/api/v1/auth/webauthn/credentials/${id}`)).statusCode).toBe(204)

      const setup = (await admin.post('/api/v1/auth/totp/setup')).json<{ secret: string }>()
      const code = (offset = 0) => hotp(base32Decode(setup.secret), totpStep(h.clock.now) + offset)
      expect((await admin.post('/api/v1/auth/totp/enable', { code: code() })).statusCode).toBe(204)
      h.clock.now += 30_000
      const disabled = await admin.post('/api/v1/auth/totp/disable', {
        password: 'ein-neues-sehr-langes-passwort',
        code: code(),
      })
      expect(disabled.statusCode, disabled.body).toBe(204)

      const notices = await mails('security_notice', 'chef@sicher.test')
      expect(notices.slice(before).map((m) => m.subject)).toEqual([
        'Test-ERP: Neuer Sicherheitsschlüssel oder Passkey',
        'Test-ERP: Sicherheitsschlüssel oder Passkey entfernt',
        'Test-ERP: Authenticator-App eingerichtet',
        'Test-ERP: Authenticator-App entfernt',
      ])
      expect(notices[before]?.body).toMatch(/„YubiKey Büro“ hinzugefügt/)
      expect(notices[before + 1]?.body).toMatch(/„YubiKey Büro“ wurde von Ihrer Anmeldung entfernt/)
    })

    it('tells a person when an admin resets the second factor', async () => {
      const invite = await admin.post('/api/v1/invitations', {
        email: 'polier@sicher.test',
        displayName: 'Paula Polier',
        roleKey: 'team_member',
      })
      expect(invite.statusCode, invite.body).toBe(201)
      const token = new URL(invite.json().acceptUrl).hash.slice(1)
      const member = new Client(h.app)
      const joined = await member.post('/api/v1/invitations/accept', {
        token,
        password: 'monteur-passwort-1',
      })
      expect(joined.statusCode, joined.body).toBe(200)
      const memberId = joined.json<{ me: Me }>().me.user.id
      expect((await admin.post(`/api/v1/users/${memberId}/reset-mfa`)).statusCode).toBe(204)
      const notices = await mails('security_notice', 'polier@sicher.test')
      expect(notices.at(-1)?.subject).toBe('Test-ERP: Zweiter Faktor zurückgesetzt')
      expect(notices.at(-1)?.body).toMatch(/Chef hat am .* alle zweiten Faktoren/)
    })

    it('changes the own address only after the link to the new address is confirmed', async () => {
      const wrong = await admin.post('/api/v1/auth/email/change', {
        newEmail: 'neu@sicher.test',
        currentPassword: 'falsch',
      })
      expect(wrong.statusCode).toBe(403)
      const res = await admin.post('/api/v1/auth/email/change', {
        newEmail: 'Neu@Sicher.test',
        currentPassword: 'ein-neues-sehr-langes-passwort',
      })
      expect(res.statusCode, res.body).toBe(202)
      expect(res.json<EmailChangeRequested>()).toMatchObject({ emailEnabled: true, changed: false })
      // The old address is told at once, the change waits for the link.
      const old = await mails('security_notice', 'chef@sicher.test')
      expect(old.at(-1)?.subject).toMatch(/Änderung Ihrer E-Mail-Adresse angefordert/)
      expect((await admin.get('/api/v1/auth/me')).json<Me>().user.email).toBe('chef@sicher.test')

      const token = await linkFrom('email_change', 'neu@sicher.test')
      const anonymous = new Client(h.app)
      const info = await anonymous.post('/api/v1/auth/email/change/lookup', { token })
      expect(info.json<EmailChangeInfo>()).toEqual({
        displayName: 'Chef',
        oldEmail: 'chef@sicher.test',
        newEmail: 'neu@sicher.test',
      })
      expect(
        (await anonymous.post('/api/v1/auth/email/change/confirm', { token })).statusCode,
      ).toBe(204)
      // Single use.
      expect(
        (await anonymous.post('/api/v1/auth/email/change/confirm', { token })).statusCode,
      ).toBe(410)
      const me = (await admin.get('/api/v1/auth/me')).json<Me>()
      expect(me.user).toMatchObject({ email: 'neu@sicher.test', emailVerified: true })
      expect((await mails('security_notice', 'chef@sicher.test')).at(-1)?.subject).toMatch(
        /E-Mail-Adresse wurde geändert/,
      )
      const login = await new Client(h.app).post('/api/v1/auth/login', {
        email: 'neu@sicher.test',
        password: 'ein-neues-sehr-langes-passwort',
      })
      expect(login.statusCode).toBe(200)
    })

    it('refuses an address that another login uses', async () => {
      const invite = await admin.post('/api/v1/invitations', {
        email: 'monteur@sicher.test',
        roleKey: 'team_member',
      })
      await new Client(h.app).post('/api/v1/invitations/accept', {
        token: new URL(invite.json().acceptUrl).hash.slice(1),
        displayName: 'Monteur',
        password: 'monteur-passwort-1',
      })
      const res = await admin.post('/api/v1/auth/email/change', {
        newEmail: 'monteur@sicher.test',
        currentPassword: 'ein-neues-sehr-langes-passwort',
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().errors.newEmail).toBe('Adresse bereits vergeben.')
    })

    it('changes the address at once (unconfirmed) without SMTP', async () => {
      const plain = await createHarness({ requireAdminMfa: false })
      try {
        const c = new Client(plain.app)
        await c.post('/api/v1/setup', {
          setupToken: plain.setupToken,
          company: { name: 'Ohne Mail GmbH' },
          admin: { email: 'a@ohne.test', password: PASSWORD, displayName: 'A' },
        })
        const res = await c.post('/api/v1/auth/email/change', {
          newEmail: 'b@ohne.test',
          currentPassword: PASSWORD,
        })
        expect(res.statusCode, res.body).toBe(200)
        expect(res.json<EmailChangeRequested>()).toEqual({
          emailEnabled: false,
          changed: true,
          expiresAt: null,
        })
        expect((await c.get('/api/v1/auth/me')).json<Me>().user).toMatchObject({
          email: 'b@ohne.test',
          emailVerified: false,
        })
      } finally {
        await plain.close()
      }
    })

    it('describes devices briefly', () => {
      expect(deviceLabel(undefined)).toBe('unbekanntes Gerät')
      expect(
        deviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0'),
      ).toBe('Edge auf Windows')
      expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko Firefox/130.0')).toBe(
        'Firefox auf Linux',
      )
      expect(deviceLabel('Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile')).toBe(
        'Chrome auf Android',
      )
      expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Safari/605.1.15')).toBe(
        'Safari auf macOS',
      )
      expect(deviceLabel('curl/8.0')).toBe('Browser')
    })
  },
)

describe.skipIf(!process.env.DATABASE_URL)('Passwort-Pepper (integration)', () => {
  const PEPPER = 'p'.repeat(40)
  let h: Harness

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false, passwordPepper: PEPPER })
  })

  afterAll(async () => {
    await h?.close()
  })

  const storedHash = async (email: string) =>
    (
      await h.adminSql<{ hash: string }[]>`
      select password_hash as hash from app_user where email = ${email}`
    )[0]?.hash

  it('stores new passwords with the pepper and upgrades old hashes at the next login', async () => {
    const admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Pfeffer Bau GmbH' },
      admin: {
        email: 'chef@pfeffer.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    expect(await storedHash('chef@pfeffer.test')).toMatch(
      new RegExp(`^pepper:${pepperKeyId(PEPPER)}:\\$argon2id\\$`),
    )

    // A hash from before the pepper was switched on still works and is upgraded.
    await h.adminSql`update app_user set password_hash = ${await new PasswordHasher().hash('ein-sehr-langes-passwort')}
                     where email = 'chef@pfeffer.test'`
    const login = await new Client(h.app).post('/api/v1/auth/login', {
      email: 'chef@pfeffer.test',
      password: 'ein-sehr-langes-passwort',
    })
    expect(login.statusCode, login.body).toBe(200)
    expect(parseStoredHash((await storedHash('chef@pfeffer.test')) as string).keyId).toBe(
      pepperKeyId(PEPPER),
    )
    expect(
      await unusablePasswordHashes({
        sql: h.adminSql,
        passwords: new PasswordHasher({ pepper: PEPPER }),
      }),
    ).toBe(0)
    expect(await unusablePasswordHashes({ sql: h.adminSql, passwords: new PasswordHasher() })).toBe(
      1,
    )
  })
})
