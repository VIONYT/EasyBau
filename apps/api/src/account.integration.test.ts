import type { AdminPasswordReset, Me } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Konto (P2.10): Passwort vergessen per E-Mail-Link, Link der Administration, E-Mail-Bestätigung.
 * Tokens are stored only as SHA-256, single-use and short-lived; passwords as argon2id.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'Konto: Passwort vergessen, E-Mail-Bestätigung (integration)',
  () => {
    let h: Harness
    let admin: Client
    let workerId: string
    const PASSWORD = 'ein-sehr-langes-passwort'

    /** The link from the last queued mail of a kind to an address. */
    async function linkFrom(kind: string, to: string): Promise<string> {
      const [row] = await h.adminSql<{ body: string }[]>`
      select body_text as body from email_message where kind = ${kind} and to_address = ${to}
      order by created_at desc limit 1`
      const match = /#([A-Za-z0-9_-]{43})/.exec(row?.body ?? '')
      if (!match) throw new Error(`no link in ${kind} mail to ${to}`)
      return match[1] as string
    }
    const login = (client: Client, email: string, password: string) =>
      client.post('/api/v1/auth/login', { email, password })

    beforeAll(async () => {
      h = await createHarness({ requireAdminMfa: false, smtp: true })
      admin = new Client(h.app)
      await admin.post('/api/v1/setup', {
        setupToken: h.setupToken,
        company: { name: 'Konto Bau GmbH' },
        admin: { email: 'chef@example.test', password: PASSWORD, displayName: 'Chef' },
      })
      const invite = await admin.post('/api/v1/invitations', {
        email: 'monteur@example.test',
        roleKey: 'team_member',
      })
      const worker = new Client(h.app)
      const accepted = await worker.post('/api/v1/invitations/accept', {
        token: new URL(invite.json().acceptUrl).hash.slice(1),
        displayName: 'Monteur',
        password: 'monteur-passwort-1',
      })
      workerId = accepted.json().me.user.id
    })

    afterAll(async () => {
      await h?.close()
    })

    it('stores passwords as argon2id with RFC 9106 parameters and upgrades old hashes at login', async () => {
      const [row] = await h.adminSql<{ hash: string }[]>`
      select password_hash as hash from app_user where email = 'chef@example.test'`
      expect(row?.hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)
      // An old hash (OWASP minimum) is replaced on the next successful login.
      const { hash } = await import('@node-rs/argon2')
      const old = await hash('monteur-passwort-1', {
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      })
      await h.adminSql`update app_user set password_hash = ${old} where id = ${workerId}`
      expect(
        (await login(new Client(h.app), 'monteur@example.test', 'monteur-passwort-1')).statusCode,
      ).toBe(200)
      const [after] = await h.adminSql<
        { hash: string }[]
      >`select password_hash as hash from app_user where id = ${workerId}`
      expect(after?.hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)
    })

    it('resets a forgotten password with a single-use link and ends all sessions', async () => {
      const other = new Client(h.app)
      expect((await login(other, 'monteur@example.test', 'monteur-passwort-1')).statusCode).toBe(
        200,
      )

      // Same answer for unknown addresses: nobody learns who has a login.
      const unknown = await new Client(h.app).post('/api/v1/auth/password-reset/request', {
        email: 'niemand@example.test',
      })
      const known = await new Client(h.app).post('/api/v1/auth/password-reset/request', {
        email: 'Monteur@Example.test',
      })
      expect(unknown.statusCode).toBe(202)
      expect(known.statusCode).toBe(202)
      expect(known.json()).toEqual(unknown.json())
      const [count] = await h.adminSql<{ n: number }[]>`
      select count(*)::int as n from email_message where kind = 'password_reset'`
      expect(count?.n).toBe(1)

      const token = await linkFrom('password_reset', 'monteur@example.test')
      // Only the hash is stored.
      const stored = await h.adminSql<
        { hash: Buffer }[]
      >`select token_hash as hash from account_token`
      expect(stored.map((s) => s.hash.length)).toEqual([32])
      expect(JSON.stringify(stored)).not.toContain(token)

      const anon = new Client(h.app)
      expect(
        (await anon.post('/api/v1/auth/password-reset/lookup', { token })).json(),
      ).toMatchObject({
        email: 'monteur@example.test',
        displayName: 'Monteur',
      })
      const short = await anon.post('/api/v1/auth/password-reset/confirm', {
        token,
        password: 'kurz',
      })
      expect(short.statusCode).toBe(400)
      const done = await anon.post('/api/v1/auth/password-reset/confirm', {
        token,
        password: 'neues-passwort-2026',
      })
      expect(done.statusCode, done.body).toBe(204)
      // Single use, old password gone, existing sessions ended.
      expect(
        (
          await anon.post('/api/v1/auth/password-reset/confirm', {
            token,
            password: 'noch-ein-passwort',
          })
        ).statusCode,
      ).toBe(410)
      expect(
        (await login(new Client(h.app), 'monteur@example.test', 'monteur-passwort-1')).statusCode,
      ).toBe(401)
      expect(
        (await login(new Client(h.app), 'monteur@example.test', 'neues-passwort-2026')).statusCode,
      ).toBe(200)
      expect((await other.get('/api/v1/auth/me')).statusCode).toBe(401)
      // The reset proves access to the inbox.
      const [verified] = await h.adminSql<{ v: boolean }[]>`
      select email_verified_at is not null as v from app_user where id = ${workerId}`
      expect(verified?.v).toBe(true)
    })

    it('rejects expired and forged links', async () => {
      await new Client(h.app).post('/api/v1/auth/password-reset/request', {
        email: 'monteur@example.test',
      })
      const token = await linkFrom('password_reset', 'monteur@example.test')
      await h.adminSql`update account_token set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'`
      const anon = new Client(h.app)
      expect(
        (
          await anon.post('/api/v1/auth/password-reset/confirm', {
            token,
            password: 'neues-passwort-2027',
          })
        ).statusCode,
      ).toBe(410)
      expect(
        (await anon.post('/api/v1/auth/password-reset/lookup', { token: 'A'.repeat(43) }))
          .statusCode,
      ).toBe(410)
      expect(
        (await anon.post('/api/v1/auth/password-reset/lookup', { token: 'zu-kurz' })).statusCode,
      ).toBe(400)
    })

    it('lets the administration create a link for a person of the company', async () => {
      const res = await admin.post(`/api/v1/users/${workerId}/password-reset`, {})
      expect(res.statusCode, res.body).toBe(201)
      const reset = res.json() as AdminPasswordReset
      expect(reset.resetUrl).toMatch(/\/passwort-zuruecksetzen#[A-Za-z0-9_-]{43}$/)
      expect(reset.emailQueued).toBe(false)
      // With SMTP set up a password link expires after half an hour at the latest.
      const minutes = (Date.parse(reset.expiresAt) - Date.now()) / 60_000
      expect(minutes).toBeGreaterThan(25)
      expect(minutes).toBeLessThanOrEqual(30.5)
      const token = reset.resetUrl.split('#')[1] as string
      expect(
        (
          await new Client(h.app).post('/api/v1/auth/password-reset/confirm', {
            token,
            password: 'vom-chef-gesetzt-1',
          })
        ).statusCode,
      ).toBe(204)
      expect(
        (await login(new Client(h.app), 'monteur@example.test', 'vom-chef-gesetzt-1')).statusCode,
      ).toBe(200)
      // Not for oneself, not without the right.
      const [me] = await h.adminSql<
        { id: string }[]
      >`select id from app_user where email = 'chef@example.test'`
      expect((await admin.post(`/api/v1/users/${me?.id}/password-reset`, {})).statusCode).toBe(409)
      const worker = new Client(h.app)
      await login(worker, 'monteur@example.test', 'vom-chef-gesetzt-1')
      expect((await worker.post(`/api/v1/users/${me?.id}/password-reset`, {})).statusCode).toBe(403)
    })

    it('confirms the e-mail address with a link', async () => {
      let me = (await admin.get('/api/v1/auth/me')).json() as Me
      expect(me.user.emailVerified).toBe(false)
      const res = await admin.post('/api/v1/auth/email/verify-request', {})
      expect(res.json()).toEqual({ emailEnabled: true, alreadyVerified: false })
      const token = await linkFrom('email_verify', 'chef@example.test')
      expect(
        (await new Client(h.app).post('/api/v1/auth/email/verify', { token })).statusCode,
      ).toBe(204)
      me = (await admin.get('/api/v1/auth/me')).json() as Me
      expect(me.user.emailVerified).toBe(true)
      expect((await admin.post('/api/v1/auth/email/verify-request', {})).json()).toMatchObject({
        alreadyVerified: true,
      })
      expect(
        (await new Client(h.app).post('/api/v1/auth/email/verify', { token })).statusCode,
      ).toBe(410)
    })
  },
)
