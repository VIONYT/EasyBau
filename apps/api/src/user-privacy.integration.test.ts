import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/** Datenschutz für Benutzerkonten: Auskunft (Art. 15) und Löschen des Zugangs. */
describe.skipIf(!process.env.DATABASE_URL)('Datenschutz bei Benutzerkonten (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client
  let workerId: string

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Zugang Bau GmbH' },
      admin: {
        email: 'chef@zugang.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    const invite = await admin.post('/api/v1/invitations', {
      email: 'monteur@zugang.test',
      roleKey: 'team_member',
    })
    worker = new Client(h.app)
    const accepted = await worker.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Max Monteur',
      password: 'monteur-passwort-1',
    })
    workerId = accepted.json().me.user.id
    await worker.post('/api/v1/projects', { name: 'Testbau' }).catch(() => undefined)
  })

  afterAll(async () => {
    await h?.close()
  })

  it('gives a person the Auskunft about their own login', async () => {
    const res = await worker.get('/api/v1/auth/privacy-report')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/Auskunft_Zugang_/)
    const report = res.json()
    expect(report.Zugang).toMatchObject({ Name: 'Max Monteur', 'E-Mail': 'monteur@zugang.test' })
    expect(report.Mitgliedschaft).toMatchObject({ Firma: 'Zugang Bau GmbH' })
    expect(report['Aktive Sitzungen'].length).toBeGreaterThanOrEqual(1)
    expect(report['Bekannte Geräte'].length).toBeGreaterThanOrEqual(1)
    // Only the administration may ask for someone else.
    expect((await worker.get(`/api/v1/users/${workerId}/privacy-report`)).statusCode).toBe(403)
    const byAdmin = await admin.get(`/api/v1/users/${workerId}/privacy-report`)
    expect(byAdmin.json().Zugang.Name).toBe('Max Monteur')
  })

  it('erases the login data of a person who belongs to no company any more', async () => {
    expect((await admin.delete(`/api/v1/users/${workerId}`)).statusCode).toBe(204)
    const [user] = await h.adminSql<
      { email: string; name: string; password: string | null; active: boolean }[]
    >`select email, display_name as name, password_hash as password, is_active as active
      from app_user where id = ${workerId}`
    expect(user).toMatchObject({
      email: `geloescht-${workerId}@invalid`,
      name: 'Max Monteur',
      password: null,
      active: false,
    })
    const [left] = await h.adminSql<{ n: number }[]>`
      select (select count(*) from user_session where user_id = ${workerId})
           + (select count(*) from known_device where user_id = ${workerId})::int as n`
    expect(Number(left?.n)).toBe(0)
    // The address can be invited again (new login).
    const again = await admin.post('/api/v1/invitations', {
      email: 'monteur@zugang.test',
      roleKey: 'team_member',
    })
    expect(again.statusCode, again.body).toBe(201)
    const login = await new Client(h.app).post('/api/v1/auth/login', {
      email: 'monteur@zugang.test',
      password: 'monteur-passwort-1',
    })
    expect(login.statusCode).toBe(401)
  })
})
