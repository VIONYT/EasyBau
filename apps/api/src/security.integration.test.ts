import { withTenant } from '@opc/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'
import { SoftAuthenticator } from './testing/soft-authenticator.js'

const ORIGIN = 'http://localhost:80' // what inject() looks like to the server (no PUBLIC_URL)
const ADMIN = {
  email: 'chef@example.test',
  password: 'ein-sehr-langes-passwort',
  displayName: 'Chef',
}

describe.skipIf(!process.env.DATABASE_URL)(
  'security keys (WebAuthn) and user management (integration)',
  () => {
    let h: Harness
    let admin: Client
    let yubikey: SoftAuthenticator

    beforeAll(async () => {
      h = await createHarness()
      admin = new Client(h.app)
      const res = await admin.post('/api/v1/setup', {
        setupToken: h.setupToken,
        company: { name: 'Sicher Bau GmbH' },
        admin: ADMIN,
      })
      expect(res.statusCode).toBe(201)
      yubikey = new SoftAuthenticator(ORIGIN)
    })

    afterAll(async () => {
      await h?.close()
    })

    describe('Sicherheitsschlüssel registrieren', () => {
      it('offers registration options bound to the domain', async () => {
        const res = await admin.post('/api/v1/auth/webauthn/register/options')
        expect(res.statusCode).toBe(200)
        const options = res.json()
        expect(options.rp).toEqual({ id: 'localhost', name: 'Test-ERP' })
        expect(options.user.name).toBe(ADMIN.email)
        expect(options.authenticatorSelection.residentKey).toBe('preferred')
        expect(admin.has('challenge')).toBe(true)
      })

      it('rejects a response that does not match the challenge', async () => {
        await admin.post('/api/v1/auth/webauthn/register/options')
        const forged = yubikey.register({ challenge: 'falscher-challenge', user: { id: 'x' } })
        const res = await admin.post('/api/v1/auth/webauthn/register/verify', {
          response: forged,
          name: 'Fake',
        })
        expect(res.statusCode).toBe(400)
      })

      it('registers a YubiKey-like security key and satisfies the admin 2FA requirement', async () => {
        expect((await admin.get('/api/v1/projects')).statusCode).toBe(403)
        const options = (await admin.post('/api/v1/auth/webauthn/register/options')).json()
        const res = await admin.post('/api/v1/auth/webauthn/register/verify', {
          response: yubikey.register(options),
          name: 'YubiKey Büro',
        })
        expect(res.statusCode).toBe(201)
        const security = (await admin.get('/api/v1/auth/security')).json()
        expect(security.credentials).toMatchObject([
          { name: 'YubiKey Büro', deviceType: 'singleDevice' },
        ])
        expect((await admin.get('/api/v1/auth/me')).json()).toMatchObject({
          twoFactorSetupRequired: false,
          user: { webauthnCount: 1 },
        })
        expect((await admin.get('/api/v1/projects')).statusCode).toBe(200)
      })

      it('does not register the same key twice', async () => {
        const options = (await admin.post('/api/v1/auth/webauthn/register/options')).json()
        expect(options.excludeCredentials).toHaveLength(1)
        const res = await admin.post('/api/v1/auth/webauthn/register/verify', {
          response: yubikey.register(options),
          name: 'Nochmal',
        })
        expect(res.statusCode).toBe(409)
      })

      it('renames a key and refuses to delete the last factor of an admin', async () => {
        const [key] = (await admin.get('/api/v1/auth/security')).json().credentials
        expect(
          (await admin.patch(`/api/v1/auth/webauthn/credentials/${key.id}`, { name: 'YubiKey 5C' }))
            .statusCode,
        ).toBe(204)
        expect((await admin.delete(`/api/v1/auth/webauthn/credentials/${key.id}`)).statusCode).toBe(
          409,
        )
      })
    })

    describe('Anmeldung mit Sicherheitsschlüssel', () => {
      it('asks for the second factor after the password', async () => {
        const client = new Client(h.app)
        const res = await client.post('/api/v1/auth/login', {
          email: ADMIN.email,
          password: ADMIN.password,
        })
        expect(res.json()).toEqual({ status: 'mfa_required', methods: ['webauthn'] })
        expect(client.has('sid')).toBe(false)
        expect((await client.get('/api/v1/auth/me')).statusCode).toBe(401)

        const options = (await client.post('/api/v1/auth/login/webauthn/options')).json()
        expect(options.allowCredentials).toHaveLength(1)
        const ok = await client.post('/api/v1/auth/login/webauthn/verify', {
          response: yubikey.authenticate(options),
        })
        expect(ok.statusCode).toBe(200)
        expect(ok.json().status).toBe('ok')
        expect(client.has('sid')).toBe(true)
        expect(client.has('challenge')).toBe(false)
      })

      it('rejects a replayed signature (counter and challenge)', async () => {
        const client = new Client(h.app)
        await client.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password })
        const options = (await client.post('/api/v1/auth/login/webauthn/options')).json()
        const assertion = yubikey.authenticate(options)
        expect(
          (await client.post('/api/v1/auth/login/webauthn/verify', { response: assertion }))
            .statusCode,
        ).toBe(200)

        const attacker = new Client(h.app)
        await attacker.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password })
        await attacker.post('/api/v1/auth/login/webauthn/options')
        expect(
          (await attacker.post('/api/v1/auth/login/webauthn/verify', { response: assertion }))
            .statusCode,
        ).toBe(401)
      })

      it('requires a pending login for the second step', async () => {
        const client = new Client(h.app)
        expect((await client.post('/api/v1/auth/login/webauthn/options')).statusCode).toBe(401)
        expect((await client.post('/api/v1/auth/login/totp', { code: '123456' })).statusCode).toBe(
          401,
        )
      })

      it('limits attempts per pending login', async () => {
        const client = new Client(h.app)
        await client.post('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password })
        const statuses: number[] = []
        for (let i = 0; i < 6; i++)
          statuses.push(
            (await client.post('/api/v1/auth/login/webauthn/verify', { response: {} })).statusCode,
          )
        expect(statuses.at(-1)).toBe(429)
      })

      it('logs in without password with a passkey (discoverable key with PIN)', async () => {
        const client = new Client(h.app)
        const options = (await client.post('/api/v1/auth/passkey/options')).json()
        expect(options.userVerification).toBe('required')
        expect(options.allowCredentials ?? []).toHaveLength(0)
        const res = await client.post('/api/v1/auth/passkey/verify', {
          response: yubikey.authenticate(options),
        })
        expect(res.statusCode).toBe(200)
        expect(res.json().me.user.email).toBe(ADMIN.email)
      })

      it('requires user verification (PIN) for passwordless login', async () => {
        const client = new Client(h.app)
        const options = (await client.post('/api/v1/auth/passkey/options')).json()
        const res = await client.post('/api/v1/auth/passkey/verify', {
          response: yubikey.authenticate(options, { userVerified: false }),
        })
        expect(res.statusCode).toBe(401)
      })

      it('rejects unknown keys', async () => {
        const client = new Client(h.app)
        const options = (await client.post('/api/v1/auth/passkey/options')).json()
        const stranger = new SoftAuthenticator(ORIGIN)
        expect(
          (
            await client.post('/api/v1/auth/passkey/verify', {
              response: stranger.authenticate(options),
            })
          ).statusCode,
        ).toBe(401)
      })

      it('rejects keys used on another website (phishing protection)', async () => {
        const client = new Client(h.app)
        const options = (await client.post('/api/v1/auth/passkey/options')).json()
        const phishing = new SoftAuthenticator('https://erp-login.example')
        expect(
          (
            await client.post('/api/v1/auth/passkey/verify', {
              response: phishing.authenticate(options),
            })
          ).statusCode,
        ).toBe(401)
      })
    })

    describe('Benutzerverwaltung', () => {
      let inviteUrl = ''
      let member: Client
      let memberId = ''

      it('lists roles and members', async () => {
        const roles = (await admin.get('/api/v1/roles')).json()
        expect(roles.map((r: { key: string }) => r.key)).toEqual([
          'admin',
          'office_lead',
          'project_lead',
          'team_lead',
          'team_member',
          'auditor',
        ])
        const members = (await admin.get('/api/v1/users')).json()
        expect(members).toMatchObject([
          { email: ADMIN.email, role: { key: 'admin' }, isSelf: true, webauthnCount: 1 },
        ])
      })

      it('invites a person with a one-time link', async () => {
        const res = await admin.post('/api/v1/invitations', {
          email: 'Monteur@Example.test',
          displayName: 'Max Monteur',
          roleKey: 'team_member',
        })
        expect(res.statusCode).toBe(201)
        inviteUrl = res.json().acceptUrl
        expect(inviteUrl).toMatch(/^http:\/\/localhost(:80)?\/einladung#[\w-]{43}$/)
        expect((await admin.get('/api/v1/invitations')).json()).toMatchObject([
          { email: 'monteur@example.test' },
        ])
        const again = await admin.post('/api/v1/invitations', {
          email: ADMIN.email,
          roleKey: 'team_member',
        })
        expect(again.statusCode).toBe(409)
      })

      it('shows the invitation and lets the person join with a password', async () => {
        const token = inviteUrl.split('#')[1] as string
        member = new Client(h.app)
        const info = (await member.post('/api/v1/invitations/lookup', { token })).json()
        expect(info).toEqual({
          tenantName: 'Sicher Bau GmbH',
          email: 'monteur@example.test',
          displayName: 'Max Monteur',
          roleName: 'Teammitglied (Baustelle)',
          existingAccount: false,
        })
        const weak = await member.post('/api/v1/invitations/accept', {
          token,
          password: 'kurz',
        })
        expect(weak.statusCode).toBe(400)
        const res = await member.post('/api/v1/invitations/accept', {
          token,
          password: 'monteur-passwort-1',
        })
        expect(res.statusCode).toBe(200)
        expect(res.json().me).toMatchObject({
          tenant: { name: 'Sicher Bau GmbH' },
          role: { key: 'team_member' },
        })
        memberId = res.json().me.user.id
        // one-time: the link is used up
        expect(
          (await new Client(h.app).post('/api/v1/invitations/lookup', { token })).statusCode,
        ).toBe(404)
      })

      it('denies user management to non-admins', async () => {
        expect((await member.get('/api/v1/users')).statusCode).toBe(403)
        expect(
          (await member.post('/api/v1/invitations', { email: 'x@example.test', roleKey: 'admin' }))
            .statusCode,
        ).toBe(403)
      })

      it('changes roles but never the own one and never the last admin', async () => {
        expect(
          (await admin.patch(`/api/v1/users/${memberId}`, { roleKey: 'team_lead' })).statusCode,
        ).toBe(204)
        expect((await member.get('/api/v1/auth/me')).json().role.key).toBe('team_lead')
        const self = (await admin.get('/api/v1/auth/me')).json().user.id
        expect(
          (await admin.patch(`/api/v1/users/${self}`, { roleKey: 'team_member' })).statusCode,
        ).toBe(409)
        expect(
          (await admin.patch(`/api/v1/users/${memberId}`, { roleKey: 'gibt-es-nicht' })).statusCode,
        ).toBe(400)
        const [tenant] = await h.adminSql<{ id: string }[]>`select id from tenant`
        await expect(
          withTenant(
            h.sql,
            { tenantId: tenant?.id as string },
            (tx) => tx`delete from membership where user_id = ${self}`,
          ),
        ).rejects.toThrow(/last admin/)
      })

      it('existing logins must confirm their password to join another company', async () => {
        const [ids] = await h.adminSql<{ id: string }[]>`select uuid_v7() as id`
        const other = ids?.id as string
        await withTenant(h.sql, { tenantId: other }, async (tx) => {
          await tx`insert into tenant (id, name) values (${other}, 'Zweite Firma')`
          await tx`select seed_tenant_defaults()`
          await tx`insert into invitation (tenant_id, email, role_id, token_hash, expires_at)
                 select ${other}, 'monteur@example.test', id, sha256('second-company-token-0123456789'::bytea),
                        now() + interval '1 day' from role where key = 'team_member'`
        })
        const token = 'second-company-token-0123456789'
        const client = new Client(h.app)
        expect(
          (await client.post('/api/v1/invitations/lookup', { token })).json().existingAccount,
        ).toBe(true)
        expect(
          (
            await client.post('/api/v1/invitations/accept', {
              token,
              password: 'falsches-passwort-1',
            })
          ).statusCode,
        ).toBe(403)
        const ok = await client.post('/api/v1/invitations/accept', {
          token,
          password: 'monteur-passwort-1',
        })
        expect(ok.json().me.memberships).toHaveLength(2)
        // Now two companies: the admin of one may not reset this login's factors.
        expect((await admin.post(`/api/v1/users/${memberId}/reset-mfa`)).statusCode).toBe(409)
      })

      it('revokes invitations', async () => {
        const res = await admin.post('/api/v1/invitations', {
          email: 'bauleiter@example.test',
          roleKey: 'project_lead',
        })
        const { invitation, acceptUrl } = res.json()
        expect((await admin.delete(`/api/v1/invitations/${invitation.id}`)).statusCode).toBe(204)
        const token = acceptUrl.split('#')[1]
        expect(
          (await new Client(h.app).post('/api/v1/invitations/lookup', { token })).statusCode,
        ).toBe(404)
      })

      it('removes a person: membership and sessions of this company end', async () => {
        expect((await admin.delete(`/api/v1/users/${memberId}`)).statusCode).toBe(204)
        expect((await member.get('/api/v1/auth/me')).statusCode).toBe(401)
        const members = (await admin.get('/api/v1/users')).json()
        expect(members).toHaveLength(1)
        const self = members[0].userId
        expect((await admin.delete(`/api/v1/users/${self}`)).statusCode).toBe(409)
      })

      it('records security events in the audit log', async () => {
        const [tenant] = await h.adminSql<
          { id: string }[]
        >`select id from tenant where name = 'Sicher Bau GmbH'`
        const actions = (
          await h.adminSql<
            { action: string }[]
          >`select action from audit_event where tenant_id = ${tenant?.id as string}`
        ).map((r) => r.action)
        expect(actions).toEqual(
          expect.arrayContaining([
            'setup',
            'webauthn_registered',
            'login:webauthn',
            'login:passkey',
            'login:invitation',
            'member_removed',
          ]),
        )
        expect(actions.some((a) => a.startsWith('role_changed'))).toBe(true)
      })
    })
  },
)
