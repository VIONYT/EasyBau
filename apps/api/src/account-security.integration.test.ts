import type { EmailChangeInfo, EmailChangeRequested, Me } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deviceLabel } from './routes/security-notices.js'
import { Client, createHarness, type Harness } from './testing/harness.js'

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
