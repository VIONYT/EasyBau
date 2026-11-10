import { createSql, migrate, type Sql, withTenant } from '@opc/db'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApi, hashPassword } from './index.js'
import { base32Decode, hotp, totpStep } from './security/crypto.js'

const baseUrl = process.env.DATABASE_URL
const SETUP_TOKEN = 'TEST-SETU-PTOK'
const ADMIN = {
  email: 'chefin@example.test',
  password: 'sehr-geheimes-passwort-1',
  displayName: 'Erika Meister',
}

/** Every test run gets its own empty database, so the "first setup" flow can be tested. */
async function createDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = createSql(
    { DATABASE_URL: baseUrl as string, DATABASE_POOL_MAX: 1 },
    { mode: 'admin' },
  )
  const name = `opc_api_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  await admin.unsafe(`create database ${name}`)
  const url = new URL(baseUrl as string)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    drop: async () => {
      await admin.unsafe(`drop database if exists ${name} with (force)`)
      await admin.end()
    },
  }
}

describe.skipIf(!baseUrl)('API: setup, login, contacts, projects (integration)', () => {
  let db: { url: string; drop: () => Promise<void> }
  let adminSql: Sql
  let sql: Sql
  let app: FastifyInstance
  let clock = Date.parse('2026-11-08T10:00:00Z')
  let session = ''

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method,
      url,
      ...(options.body === undefined ? {} : { payload: options.body as object }),
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: `sid=${options.cookie}` }),
        ...options.headers,
      },
    })
  const as = (cookie: string) => ({
    get: (url: string) => request('GET', url, { cookie }),
    post: (url: string, body?: unknown, headers?: Record<string, string>) =>
      request('POST', url, { cookie, body: body ?? {}, ...(headers ? { headers } : {}) }),
    patch: (url: string, body: unknown, headers?: Record<string, string>) =>
      request('PATCH', url, { cookie, body, ...(headers ? { headers } : {}) }),
    delete: (url: string) => request('DELETE', url, { cookie }),
  })
  const sessionOf = (res: LightMyRequestResponse) =>
    res.cookies.find((c) => c.name === 'sid')?.value ?? ''

  beforeAll(async () => {
    db = await createDatabase()
    adminSql = createSql({ DATABASE_URL: db.url, DATABASE_POOL_MAX: 2 }, { mode: 'admin' })
    await migrate(adminSql)
    sql = createSql({ DATABASE_URL: db.url, DATABASE_POOL_MAX: 5 })
    app = buildApi({
      config: {
        APP_NAME: 'Test-ERP',
        APP_VERSION: 'test',
        APP_ROLE: 'all',
        PROFILE: 'compact',
        APP_SECRET: 'z'.repeat(40),
        COOKIE_SECURE: false,
      },
      isReady: async () => true,
      sql,
      setupToken: SETUP_TOKEN,
      now: () => clock,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await sql?.end({ timeout: 5 })
    await adminSql?.end({ timeout: 5 })
    await db?.drop()
  })

  describe('Ersteinrichtung', () => {
    it('reports that setup is required on an empty instance', async () => {
      expect((await request('GET', '/api/v1/setup/status')).json()).toEqual({ setupRequired: true })
    })

    it('validates input and lists field errors', async () => {
      const res = await request('POST', '/api/v1/setup', {
        body: { setupToken: SETUP_TOKEN, company: {}, admin: {} },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().errors).toMatchObject({
        'company.name': 'Pflichtfeld.',
        'admin.password': 'Pflichtfeld.',
      })
    })

    it('requires the setup code from the server log', async () => {
      const res = await request('POST', '/api/v1/setup', {
        body: { setupToken: 'WRONG', company: { name: 'Muster Bau GmbH' }, admin: ADMIN },
      })
      expect(res.statusCode).toBe(403)
    })

    it('rejects weak passwords', async () => {
      const res = await request('POST', '/api/v1/setup', {
        body: {
          setupToken: SETUP_TOKEN,
          company: { name: 'X' },
          admin: { ...ADMIN, password: 'kurz' },
        },
      })
      expect(res.json().errors['admin.password']).toMatch(/12 Zeichen/)
    })

    it('creates company, defaults and admin, and logs in', async () => {
      const res = await request('POST', '/api/v1/setup', {
        body: {
          setupToken: SETUP_TOKEN,
          company: {
            name: 'Muster Bau GmbH',
            trade: 'Trockenbau',
            city: 'Hannover',
            countryCode: 'de',
          },
          admin: { ...ADMIN, email: ' Chefin@Example.TEST ' },
        },
      })
      expect(res.statusCode).toBe(201)
      session = sessionOf(res)
      expect(session).toHaveLength(43)
      const cookie = res.cookies.find((c) => c.name === 'sid')
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
      const me = res.json()
      expect(me.user.email).toBe(ADMIN.email)
      expect(me.role.key).toBe('admin')
      expect(me.permissions).toContain('document.finalize')
      expect(me.twoFactorSetupRequired).toBe(true)
      expect((await request('GET', '/api/v1/setup/status')).json()).toEqual({
        setupRequired: false,
      })
    })

    it('can only be done once', async () => {
      const res = await request('POST', '/api/v1/setup', {
        body: {
          setupToken: SETUP_TOKEN,
          company: { name: 'Zweite Firma' },
          admin: { ...ADMIN, email: 'x@example.test' },
        },
      })
      expect(res.statusCode).toBe(409)
    })
  })

  describe('Anmeldung', () => {
    it('protects the API', async () => {
      const res = await request('GET', '/api/v1/contacts')
      expect(res.statusCode).toBe(401)
      expect(res.headers['content-type']).toContain('application/problem+json')
      expect(
        (await request('GET', '/api/v1/auth/me', { cookie: 'invalid-token' })).statusCode,
      ).toBe(401)
    })

    it('logs in and out', async () => {
      const login = await request('POST', '/api/v1/auth/login', {
        body: { email: ADMIN.email, password: ADMIN.password },
      })
      expect(login.statusCode).toBe(200)
      expect(login.json().status).toBe('ok')
      const token = sessionOf(login)
      expect((await as(token).get('/api/v1/auth/me')).json().tenant.name).toBe('Muster Bau GmbH')
      expect((await as(token).post('/api/v1/auth/logout')).statusCode).toBe(204)
      expect((await as(token).get('/api/v1/auth/me')).statusCode).toBe(401)
    })

    it('gives the same answer for wrong passwords and unknown e-mails', async () => {
      const wrong = await request('POST', '/api/v1/auth/login', {
        body: { email: ADMIN.email, password: 'falsch-falsch-1' },
      })
      const unknown = await request('POST', '/api/v1/auth/login', {
        body: { email: 'niemand@example.test', password: 'falsch-falsch-1' },
      })
      expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401])
      expect(wrong.json().detail).toBe(unknown.json().detail)
    })

    it('throttles repeated attempts per e-mail address', async () => {
      const attempt = () =>
        request('POST', '/api/v1/auth/login', {
          body: { email: 'brute@example.test', password: 'falsch-falsch-1' },
        })
      for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401)
      const blocked = await attempt()
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json().detail).toMatch(/Zu viele Versuche/)
    })

    it('rejects cross-site requests (CSRF)', async () => {
      const evil = await request('POST', '/api/v1/contacts', {
        cookie: session,
        body: { kind: 'organization', organizationName: 'Evil' },
        headers: { origin: 'https://evil.example' },
      })
      expect(evil.statusCode).toBe(403)
      const fetchMeta = await request('POST', '/api/v1/auth/logout', {
        cookie: session,
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      expect(fetchMeta.statusCode).toBe(403)
      const sameOrigin = await request('GET', '/api/v1/auth/me', {
        cookie: session,
        headers: { origin: 'http://localhost:80' },
      })
      expect(sameOrigin.statusCode).toBe(200)
    })

    it('blocks admins without second factor from working (server-side)', async () => {
      const res = await as(session).get('/api/v1/contacts')
      expect(res.statusCode).toBe(403)
      expect(res.json().detail).toMatch(/Zwei-Faktor/)
      expect((await as(session).get('/api/v1/auth/me')).json().twoFactorSetupRequired).toBe(true)
      expect((await as(session).get('/api/v1/auth/security')).statusCode).toBe(200)
    })

    it('enables two-factor login (TOTP) with replay protection', async () => {
      const setup = await as(session).post('/api/v1/auth/totp/setup')
      expect(setup.statusCode).toBe(200)
      const { secret, uri } = setup.json()
      expect(uri).toMatch(/^otpauth:\/\/totp\/Test-ERP/)
      const code = (offsetSteps = 0) => hotp(base32Decode(secret), totpStep(clock) + offsetSteps)

      expect(
        (await as(session).post('/api/v1/auth/totp/enable', { code: '000000' })).statusCode,
      ).toBe(400)
      expect(
        (await as(session).post('/api/v1/auth/totp/enable', { code: code() })).statusCode,
      ).toBe(204)
      expect((await as(session).get('/api/v1/auth/me')).json().twoFactorSetupRequired).toBe(false)

      const withoutCode = await request('POST', '/api/v1/auth/login', {
        body: { email: ADMIN.email, password: ADMIN.password },
      })
      expect(withoutCode.json()).toEqual({ status: 'mfa_required', methods: ['totp'] })
      expect(sessionOf(withoutCode)).toBe('')

      // The code used for enabling must not be accepted again (replay).
      const replay = await request('POST', '/api/v1/auth/login', {
        body: { email: ADMIN.email, password: ADMIN.password, totp: code() },
      })
      expect(replay.statusCode).toBe(401)

      clock += 30_000
      const ok = await request('POST', '/api/v1/auth/login', {
        body: { email: ADMIN.email, password: ADMIN.password, totp: code() },
      })
      expect(ok.statusCode).toBe(200)
      session = sessionOf(ok)
    })
  })

  describe('Kontakte', () => {
    let organizationId = ''
    let personId = ''
    let etag = ''

    it('creates an organization with customer number, channels and address', async () => {
      const res = await as(session).post('/api/v1/contacts', {
        kind: 'organization',
        organizationName: 'Hannover Wohnbau eG',
        color: '#0F4C5C',
        taxMode: 'reverse_charge_13b',
        channels: [
          { kind: 'email', value: 'info@wohnbau.example', isPrimary: true },
          { kind: 'phone', value: '+49 511 123456' },
        ],
        addresses: [
          { kind: 'main', street: 'Marktstraße 1', postalCode: '30159', city: 'Hannover' },
        ],
      })
      expect(res.statusCode).toBe(201)
      const contact = res.json()
      organizationId = contact.id
      etag = res.headers.etag as string
      expect(contact).toMatchObject({
        number: 'K-10001',
        displayName: 'Hannover Wohnbau eG',
        taxMode: 'reverse_charge_13b',
        channels: [{ kind: 'email', isPrimary: true }, { kind: 'phone' }],
        addresses: [{ city: 'Hannover', countryCode: 'DE' }],
      })
    })

    it('validates required names per kind', async () => {
      const res = await as(session).post('/api/v1/contacts', { kind: 'person' })
      expect(res.statusCode).toBe(400)
      expect(res.json().errors.lastName).toMatch(/Vor- oder Nachnamen/)
    })

    it('creates a person without customer number and links it to the organization', async () => {
      const res = await as(session).post('/api/v1/contacts', {
        kind: 'person',
        firstName: 'Anna',
        lastName: 'Schmidt',
        assignCustomerNumber: false,
      })
      personId = res.json().id
      expect(res.json()).toMatchObject({ number: null, displayName: 'Schmidt, Anna' })
      expect(
        (
          await as(session).post(`/api/v1/contacts/${personId}/links`, {
            organizationId,
            role: 'Bauleitung',
          })
        ).statusCode,
      ).toBe(204)
      const org = (await as(session).get(`/api/v1/contacts/${organizationId}`)).json()
      expect(org.links).toEqual([
        { contactId: personId, displayName: 'Schmidt, Anna', kind: 'person', role: 'Bauleitung' },
      ])
      const wrongDirection = await as(session).post(`/api/v1/contacts/${organizationId}/links`, {
        organizationId: personId,
      })
      expect(wrongDirection.statusCode).toBe(400)
    })

    it('lists, searches and pages contacts sorted by name', async () => {
      const list = (await as(session).get('/api/v1/contacts')).json()
      expect(list.items.map((c: { displayName: string }) => c.displayName)).toEqual([
        'Hannover Wohnbau eG',
        'Schmidt, Anna',
      ])
      expect(list.items[0]).toMatchObject({
        primaryEmail: 'info@wohnbau.example',
        primaryPhone: '+49 511 123456',
        city: 'Hannover',
      })
      expect((await as(session).get('/api/v1/contacts?q=marktstr')).json().items).toHaveLength(1)
      expect((await as(session).get('/api/v1/contacts?q=K-10001')).json().items).toHaveLength(1)
      expect((await as(session).get('/api/v1/contacts?kind=person')).json().items).toHaveLength(1)
      const page1 = (await as(session).get('/api/v1/contacts?limit=1')).json()
      expect(page1.nextCursor).toBeTruthy()
      const page2 = (
        await as(session).get(`/api/v1/contacts?limit=1&cursor=${page1.nextCursor}`)
      ).json()
      expect(page2.items[0].displayName).toBe('Schmidt, Anna')
      expect(page2.nextCursor).toBeNull()
      expect((await as(session).get('/api/v1/contacts?cursor=kaputt')).statusCode).toBe(400)
    })

    it('updates with optimistic locking (If-Match)', async () => {
      const ok = await as(session).patch(
        `/api/v1/contacts/${organizationId}`,
        { description: 'Stammkunde', channels: [{ kind: 'email', value: 'bau@wohnbau.example' }] },
        { 'if-match': etag },
      )
      expect(ok.statusCode).toBe(200)
      expect(ok.json().channels).toHaveLength(1)
      const stale = await as(session).patch(
        `/api/v1/contacts/${organizationId}`,
        { description: 'x' },
        { 'if-match': etag },
      )
      expect(stale.statusCode).toBe(412)
      const emptyName = await as(session).patch(`/api/v1/contacts/${organizationId}`, {
        organizationName: '',
      })
      expect(emptyName.statusCode).toBe(400)
    })

    it('replays POST requests with the same Idempotency-Key', async () => {
      const body = { kind: 'organization', organizationName: 'Doppelklick GmbH' }
      const headers = { 'idempotency-key': 'contact-create-0001' }
      const first = await as(session).post('/api/v1/contacts', body, headers)
      const second = await as(session).post('/api/v1/contacts', body, headers)
      expect(second.statusCode).toBe(201)
      expect(second.headers['idempotency-replayed']).toBe('true')
      expect(second.json().id).toBe(first.json().id)
      const other = await as(session).post(
        '/api/v1/contacts',
        { ...body, organizationName: 'Anders' },
        headers,
      )
      expect(other.statusCode).toBe(422)
      const all = (await as(session).get('/api/v1/contacts?q=doppelklick')).json()
      expect(all.items).toHaveLength(1)
    })

    it('archives contacts and deletes only unused ones', async () => {
      const temp = (
        await as(session).post('/api/v1/contacts', { kind: 'person', lastName: 'Temporär' })
      ).json()
      expect((await as(session).delete(`/api/v1/contacts/${temp.id}`)).statusCode).toBe(204)
      expect((await as(session).get(`/api/v1/contacts/${temp.id}`)).statusCode).toBe(404)
      expect((await as(session).post(`/api/v1/contacts/${personId}/archive`)).statusCode).toBe(204)
      expect((await as(session).get('/api/v1/contacts?archived=true')).json().items).toHaveLength(1)
      expect((await as(session).post(`/api/v1/contacts/${personId}/unarchive`)).statusCode).toBe(
        204,
      )
    })

    it('records changes in the audit log', async () => {
      const [tenant] = await adminSql<{ id: string }[]>`select id from tenant limit 1`
      const events = await adminSql<{ action: string }[]>`
        select action from audit_event where tenant_id = ${tenant?.id as string} and entity = 'contact'`
      expect(events.map((e) => e.action)).toEqual(
        expect.arrayContaining(['insert', 'update', 'delete']),
      )
      const [chain] = await adminSql<
        { broken: string | null }[]
      >`select verify_audit_chain(${tenant?.id as string}::uuid) as broken`
      expect(chain?.broken).toBeNull()
    })

    it('blocks deleting a contact that is used as project customer', async () => {
      await as(session).post('/api/v1/projects', { name: 'Neubau Kita', customerId: personId })
      expect((await as(session).delete(`/api/v1/contacts/${personId}`)).statusCode).toBe(409)
    })
  })

  describe('Projekte', () => {
    let projectId = ''
    let customerId = ''

    it('creates a project with number, default status, site and creator as member', async () => {
      customerId = (await as(session).get('/api/v1/contacts?q=wohnbau')).json().items[0].id
      const res = await as(session).post('/api/v1/projects', {
        name: 'Sanierung Bad EG',
        customerId,
        site: { street: 'Lister Meile 5', postalCode: '30161', city: 'Hannover' },
        startDate: '2026-11-09',
        endDate: '2026-11-20',
      })
      expect(res.statusCode).toBe(201)
      const project = res.json()
      projectId = project.id
      expect(project).toMatchObject({
        number: 'P-00102', // P-00101 went to the Kita project above
        name: 'Sanierung Bad EG',
        status: { label: 'Erstkontakt' },
        customer: { id: customerId, displayName: 'Hannover Wohnbau eG' },
        site: { city: 'Hannover', countryCode: 'DE' },
        startDate: '2026-11-09',
        members: [{ displayName: ADMIN.displayName }],
      })
    })

    it('validates dates, references and manual numbers', async () => {
      const dates = await as(session).post('/api/v1/projects', {
        name: 'X',
        startDate: '2026-11-10',
        endDate: '2026-11-01',
      })
      expect(dates.json().errors.endDate).toMatch(/Ende/)
      const ref = await as(session).post('/api/v1/projects', {
        name: 'X',
        customerId: '01a1bb86-5139-7692-aca0-cf07aa6f73f8',
      })
      expect(ref.json().errors.customerId).toBe('Unbekannter Kunde.')
      await as(session).post('/api/v1/projects', { name: 'Manuell', number: 'BV-2026-01' })
      const dup = await as(session).post('/api/v1/projects', {
        name: 'Manuell 2',
        number: 'BV-2026-01',
      })
      expect(dup.statusCode).toBe(409)
    })

    it('changes status and dates, keeping the date order', async () => {
      const statuses = (await as(session).get('/api/v1/project-statuses')).json()
      expect(statuses.map((s: { label: string }) => s.label)).toContain('In Ausführung')
      const inProgress = statuses.find((s: { key: string }) => s.key === 'in_progress')
      const res = await as(session).patch(`/api/v1/projects/${projectId}`, {
        statusId: inProgress.id,
      })
      expect(res.json().status.label).toBe('In Ausführung')
      const bad = await as(session).patch(`/api/v1/projects/${projectId}`, {
        endDate: '2026-11-01',
      })
      expect(bad.statusCode).toBe(400)
    })

    it('lists, filters and searches projects', async () => {
      const all = (await as(session).get('/api/v1/projects')).json()
      expect(all.items[0].name).toBe('Sanierung Bad EG') // most recently changed first
      expect(
        (await as(session).get(`/api/v1/projects?customerId=${customerId}`)).json().items,
      ).toHaveLength(1)
      expect((await as(session).get('/api/v1/projects?q=lister')).json().items).toHaveLength(1)
      const page1 = (await as(session).get('/api/v1/projects?limit=2')).json()
      const page2 = (
        await as(session).get(`/api/v1/projects?limit=2&cursor=${page1.nextCursor}`)
      ).json()
      const ids = [...page1.items, ...page2.items].map((p: { id: string }) => p.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toHaveLength(all.items.length)
    })

    it('archives and restores', async () => {
      expect((await as(session).post(`/api/v1/projects/${projectId}/archive`)).statusCode).toBe(204)
      expect((await as(session).get('/api/v1/projects?archived=true')).json().items).toHaveLength(1)
      expect((await as(session).post(`/api/v1/projects/${projectId}/unarchive`)).statusCode).toBe(
        204,
      )
    })
  })

  describe('Rechte und Mandantentrennung', () => {
    let tenantId = ''
    let memberSession = ''

    beforeAll(async () => {
      const [tenant] = await adminSql<{ id: string }[]>`select id from tenant limit 1`
      tenantId = tenant?.id as string
      const passwordHash = await hashPassword('monteur-passwort-123')
      const [user] = await adminSql<{ id: string }[]>`
        insert into app_user (email, display_name, password_hash)
        values ('monteur@example.test', 'Max Monteur', ${passwordHash}) returning id`
      await withTenant(
        sql,
        { tenantId },
        (tx) => tx`
        insert into membership (tenant_id, user_id, role_id)
        select ${tenantId}, ${user?.id as string}, id from role where key = 'team_member'`,
      )
      const login = await request('POST', '/api/v1/auth/login', {
        body: { email: 'monteur@example.test', password: 'monteur-passwort-123' },
      })
      memberSession = sessionOf(login)
    })

    it('denies contacts and writing projects to site team members', async () => {
      expect((await as(memberSession).get('/api/v1/contacts')).statusCode).toBe(403)
      expect(
        (await as(memberSession).post('/api/v1/projects', { name: 'Nicht erlaubt' })).statusCode,
      ).toBe(403)
    })

    it('shows team members only their assigned projects', async () => {
      expect((await as(memberSession).get('/api/v1/projects')).json().items).toHaveLength(0)
      const me = (await as(memberSession).get('/api/v1/auth/me')).json()
      const project = (await as(session).get('/api/v1/projects?q=sanierung')).json().items[0]
      const admin = (await as(session).get('/api/v1/auth/me')).json()
      await as(session).patch(`/api/v1/projects/${project.id}`, {
        memberIds: [admin.user.id, me.user.id],
      })
      const visible = (await as(memberSession).get('/api/v1/projects')).json().items
      expect(visible.map((p: { id: string }) => p.id)).toEqual([project.id])
      expect((await as(memberSession).get(`/api/v1/projects/${project.id}`)).statusCode).toBe(200)
    })

    it('never shows data of another company', async () => {
      const [ids] = await adminSql<{ tenant: string }[]>`select uuid_v7() as tenant`
      const otherTenant = ids?.tenant as string
      const passwordHash = await hashPassword('fremd-passwort-1234')
      const [user] = await adminSql<{ id: string }[]>`
        insert into app_user (email, display_name, password_hash)
        values ('fremd@example.test', 'Fremd', ${passwordHash}) returning id`
      await withTenant(sql, { tenantId: otherTenant }, async (tx) => {
        await tx`insert into tenant (id, name) values (${otherTenant}, 'Andere Firma')`
        await tx`select seed_tenant_defaults()`
        await tx`insert into membership (tenant_id, user_id, role_id)
                 select ${otherTenant}, ${user?.id as string}, id from role where key = 'office_lead'`
      })
      const login = await request('POST', '/api/v1/auth/login', {
        body: { email: 'fremd@example.test', password: 'fremd-passwort-1234' },
      })
      const other = sessionOf(login)
      const contactOfA = (await as(session).get('/api/v1/contacts')).json().items[0]
      expect((await as(other).get('/api/v1/contacts')).json().items).toHaveLength(0)
      expect((await as(other).get(`/api/v1/contacts/${contactOfA.id}`)).statusCode).toBe(404)
      expect(
        (await as(other).patch(`/api/v1/contacts/${contactOfA.id}`, { description: 'x' }))
          .statusCode,
      ).toBe(404)
      expect((await as(other).post('/api/v1/auth/switch-tenant', { tenantId })).statusCode).toBe(
        403,
      )
    })
  })
})
