import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FieldCipher } from './security/crypto.js'
import { reencryptLegacyFields } from './security/reencrypt.js'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** Hardening after the security audit run-1: proxy trust and idempotency keys. */
describe.skipIf(!process.env.DATABASE_URL)('Härtung (integration)', () => {
  let h: Harness
  let admin: Client
  let office: Client

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false, smtp: true })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Hart Bau GmbH' },
      admin: { email: 'chef@example.test', password: 'ein-sehr-langes-passwort', displayName: 'C' },
    })
  })

  afterAll(async () => {
    await h?.close()
  })

  async function resetLinkOrigin(remoteAddress: string) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      remoteAddress,
      headers: {
        host: 'erp.example.test',
        origin: 'http://erp.example.test',
        'x-forwarded-host': 'evil.invalid',
        'x-forwarded-proto': 'https',
      },
      payload: { email: 'chef@example.test' },
    })
    expect(res.statusCode, res.body).toBe(202)
    const [row] = await h.adminSql<{ body: string }[]>`
      select body_text as body from email_message where kind = 'password_reset'
      order by created_at desc limit 1`
    return /(https?:\/\/[^/\s]+)\/passwort-zuruecksetzen#/.exec(row?.body ?? '')?.[1]
  }

  it('believes X-Forwarded-* only from trusted proxies', async () => {
    // A client on the internet cannot choose the host of a reset link (or its IP for limits).
    expect(await resetLinkOrigin('203.0.113.5')).toBe('http://erp.example.test')
    // The bundled proxy (private network) is believed.
    expect(await resetLinkOrigin('172.18.0.4')).toBe('https://evil.invalid')
  })

  it('never replays another person’s response for the same Idempotency-Key', async () => {
    const body = { kind: 'organization', organizationName: 'Kunde eG' }
    const headers = { 'idempotency-key': 'gleicher-schluessel-1' }
    const first = await admin.post('/api/v1/contacts', body, headers)
    expect(first.statusCode).toBe(201)
    const again = await admin.post('/api/v1/contacts', body, headers)
    expect(again.headers['idempotency-replayed']).toBe('true')
    const invite = await admin.post('/api/v1/invitations', {
      email: 'buero@example.test',
      roleKey: 'office_lead',
    })
    office = new Client(h.app)
    await office.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Büro',
      password: 'ein-langes-passwort-1',
    })
    const other = await office.post('/api/v1/contacts', body, headers)
    expect(other.headers['idempotency-replayed']).toBeUndefined()
    expect(other.statusCode).toBe(422)
  })

  it('runs a request again whose first try never got an answer (server restarted)', async () => {
    const body = { kind: 'organization', organizationName: 'Neustart eG' }
    const headers = { 'idempotency-key': 'neustart-schluessel-1' }
    expect((await admin.post('/api/v1/contacts', body, headers)).statusCode).toBe(201)
    // As if the process had died before storing the answer.
    await h.adminSql`update idempotency_key set response_status = null, response_body = null
                     where key = 'neustart-schluessel-1'`
    expect((await admin.post('/api/v1/contacts', body, headers)).statusCode).toBe(409)
    await h.adminSql`update idempotency_key set created_at = now() - interval '10 minutes'
                     where key = 'neustart-schluessel-1'`
    const again = await admin.post('/api/v1/contacts', body, headers)
    expect(again.headers['idempotency-replayed']).toBeUndefined()
    expect(again.statusCode).not.toBe(409)
  })

  it('masks nested secrets in the Änderungsprotokoll', async () => {
    await h.adminSql`
      update tenant set settings = jsonb_set(settings, '{incomingMail}',
        '{"host":"imap.example.test","passwordEnc":"GEHEIM-CIPHERTEXT"}')`
    const res = await admin.get('/api/v1/audit/events?entity=tenant')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.body).toContain('imap.example.test')
    expect(res.body).not.toContain('GEHEIM-CIPHERTEXT')
  })

  it('hands out a drawn signature only to its owner and to readers of what it signs', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )
    const signature = (await admin.upload('/api/v1/signatures', png)).json().assetId as string
    expect((await admin.get(`/api/v1/assets/${signature}`)).statusCode).toBe(200)
    expect((await office.get(`/api/v1/assets/${signature}`)).statusCode).toBe(404)
  })

  it('needs a fresh sign-in to add or remove a second factor', async () => {
    expect((await office.post('/api/v1/auth/totp/setup')).statusCode).toBe(200)
    // The same session an hour later (e.g. left open on a shared computer).
    await h.adminSql`update user_session set created_at = now() - interval '1 hour'`
    for (const res of [
      await office.post('/api/v1/auth/totp/setup'),
      await office.post('/api/v1/auth/webauthn/register/options'),
    ]) {
      expect(res.statusCode).toBe(403)
      expect(res.json().detail).toMatch(/neu an/)
    }
  })

  it('binds encrypted values written before the field binding at start', async () => {
    const secret = 'z'.repeat(40) // APP_SECRET of the test harness
    const key = Buffer.from(
      hkdfSync('sha256', secret, 'opc-field-encryption', 'aes-256-gcm/v1', 32),
    )
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update('DE02120300000000202051', 'utf8'), c.final()])
    const v1 = Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body])
    await h.adminSql`update tenant set iban_enc = ${v1}`
    expect(await reencryptLegacyFields(h.adminSql, secret)).toBe(1)
    expect(await reencryptLegacyFields(h.adminSql, secret)).toBe(0)
    const [row] = await h.adminSql<{ iban: Buffer }[]>`select iban_enc as iban from tenant`
    const cipher = new FieldCipher(secret)
    expect(cipher.isLegacy(row?.iban as Buffer)).toBe(false)
    expect(cipher.decrypt(row?.iban as Buffer, 'tenant.iban')).toBe('DE02120300000000202051')
  })

  it('puts pg_temp last for every SECURITY DEFINER function', async () => {
    const loose = await h.adminSql<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not coalesce('search_path=public, pg_temp' = any(p.proconfig), false)`
    expect(loose).toEqual([])
  })
})
