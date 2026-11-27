import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** Hardening after the security audit run-1: proxy trust and idempotency keys. */
describe.skipIf(!process.env.DATABASE_URL)('Härtung (integration)', () => {
  let h: Harness
  let admin: Client

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
    const office = new Client(h.app)
    await office.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Büro',
      password: 'ein-langes-passwort-1',
    })
    const other = await office.post('/api/v1/contacts', body, headers)
    expect(other.headers['idempotency-replayed']).toBeUndefined()
    expect(other.statusCode).toBe(422)
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

  it('puts pg_temp last for every SECURITY DEFINER function', async () => {
    const loose = await h.adminSql<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not coalesce('search_path=public, pg_temp' = any(p.proconfig), false)`
    expect(loose).toEqual([])
  })
})
