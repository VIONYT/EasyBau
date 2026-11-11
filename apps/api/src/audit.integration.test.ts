import type {
  AuditChainStatus,
  AuditEventList,
  InviteResponse,
  MemberSummary,
  OperationsStatus,
} from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

/**
 * Änderungsprotokoll and audit-chain checks (rule 6) and the time-limited Prüfer access (GoBD Z1):
 * read-only, only with `audit.read`, the auditor's access always ends on a set day.
 */
describe.skipIf(!process.env.DATABASE_URL)('Prüfung und Audit-Kette (integration)', () => {
  let h: Harness
  let admin: Client
  let auditor: Client
  let auditorId: string

  async function join(roleKey: string, email: string, accessUntil?: string) {
    const invite = await admin.post('/api/v1/invitations', { email, roleKey, accessUntil })
    expect(invite.statusCode, invite.body).toBe(201)
    const client = new Client(h.app)
    const accepted = await client.post('/api/v1/invitations/accept', {
      token: new URL((invite.json() as InviteResponse).acceptUrl).hash.slice(1),
      displayName: roleKey,
      password: 'ein-langes-passwort-1',
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    return { client, invitation: (invite.json() as InviteResponse).invitation }
  }
  const members = async () => (await admin.get('/api/v1/users')).json() as MemberSummary[]

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Prüf Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    await admin.patch('/api/v1/settings/company', { street: 'Werkstraße 2', city: 'Hannover' })
  })
  afterAll(async () => {
    await h?.close()
  })

  it('lists the Änderungsprotokoll newest first with changed fields and paging', async () => {
    const first = (await admin.get('/api/v1/audit/events?limit=2')).json() as AuditEventList
    expect(first.items).toHaveLength(2)
    expect(first.items[0]?.seq).toBeGreaterThan(first.items[1]?.seq as number)
    expect(first.nextCursor).not.toBeNull()
    const next = (
      await admin.get(`/api/v1/audit/events?limit=2&cursor=${first.nextCursor}`)
    ).json() as AuditEventList
    expect(next.items[0]?.seq).toBeLessThan(first.items[1]?.seq as number)

    const company = (
      await admin.get('/api/v1/audit/events?entity=tenant&limit=100')
    ).json() as AuditEventList
    const update = company.items.find(
      (e) => e.action === 'update' && e.changes.some((c) => c.field === 'street'),
    )
    expect(update?.actor).toBe('Chef')
    expect(update?.changes).toContainEqual({ field: 'street', before: null, after: 'Werkstraße 2' })
    // Only changed fields of an update; technical columns are left out.
    expect(update?.changes.map((c) => c.field).sort()).toEqual(['city', 'street'])
    expect((await admin.get('/api/v1/audit/events?from=2026-13-01')).statusCode).toBe(400)
  })

  it('checks the chain on request and shows the result in the Betriebs-Check', async () => {
    let chain = (await admin.get('/api/v1/audit/chain')).json() as AuditChainStatus
    expect(chain).toMatchObject({ last: null, recent: [], stale: true })
    const res = await admin.post('/api/v1/audit/chain/check', {})
    expect(res.statusCode, res.body).toBe(201)
    chain = res.json()
    expect(chain.stale).toBe(false)
    expect(chain.last).toMatchObject({ origin: 'manual', checkedBy: 'Chef', problem: null })
    expect(chain.last?.events).toBeGreaterThan(3)
    const ops = (await admin.get('/api/v1/settings/operations')).json() as OperationsStatus
    expect(ops.audit).toMatchObject({ problem: null, stale: false, brokenSeq: null })
  })

  it('invites a Prüfer only with an end date of at most one year', async () => {
    const missing = await admin.post('/api/v1/invitations', {
      email: 'pruefer@finanzamt.example',
      roleKey: 'auditor',
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().errors).toEqual({ accessUntil: 'Bitte ein Enddatum angeben.' })
    const tooLong = await admin.post('/api/v1/invitations', {
      email: 'pruefer@finanzamt.example',
      roleKey: 'auditor',
      accessUntil: '2028-01-01',
    })
    expect(tooLong.statusCode).toBe(400)
    const joined = await join('auditor', 'pruefer@finanzamt.example', '2026-12-31')
    auditor = joined.client
    expect(joined.invitation.accessUntil).toBe('2026-12-31')
    const member = (await members()).find((m) => m.email === 'pruefer@finanzamt.example')
    expect(member).toMatchObject({ validUntil: '2026-12-31', expired: false })
    auditorId = member?.userId as string
  })

  it('gives the Prüfer read-only access to the protocol, documents and exports', async () => {
    expect((await auditor.get('/api/v1/audit/events')).statusCode).toBe(200)
    expect((await auditor.get('/api/v1/audit/chain')).statusCode).toBe(200)
    expect((await auditor.get('/api/v1/invoices')).statusCode).toBe(200)
    expect((await auditor.get('/api/v1/projects')).statusCode).toBe(200)
    // No settings, no changes.
    expect((await auditor.get('/api/v1/settings/operations')).statusCode).toBe(403)
    expect((await auditor.post('/api/v1/projects', { name: 'X' })).statusCode).toBe(403)
    expect((await auditor.patch('/api/v1/settings/company', { street: 'Fremd' })).statusCode).toBe(
      403,
    )
    // A site worker has no access to the protocol.
    const { client: worker } = await join('team_member', 'monteur@example.test')
    expect((await worker.get('/api/v1/audit/events')).statusCode).toBe(403)
    expect((await worker.post('/api/v1/audit/chain/check', {})).statusCode).toBe(403)
  })

  it('extends or shortens the access; never unlimited for a Prüfer', async () => {
    expect((await admin.patch(`/api/v1/users/${auditorId}`, { validUntil: null })).statusCode).toBe(
      400,
    )
    expect(
      (await admin.patch(`/api/v1/users/${auditorId}`, { validUntil: '2026-01-01' })).statusCode,
    ).toBe(400)
    const extended = await admin.patch(`/api/v1/users/${auditorId}`, { validUntil: '2027-03-31' })
    expect(extended.statusCode, extended.body).toBe(204)
    expect((await members()).find((m) => m.userId === auditorId)?.validUntil).toBe('2027-03-31')
    // Changing a member into a Prüfer needs an end date as well.
    const worker = (await members()).find((m) => m.email === 'monteur@example.test')
    expect(
      (await admin.patch(`/api/v1/users/${worker?.userId}`, { roleKey: 'auditor' })).statusCode,
    ).toBe(400)
    expect(
      (
        await admin.patch(`/api/v1/users/${worker?.userId}`, {
          roleKey: 'auditor',
          validUntil: '2026-12-31',
        })
      ).statusCode,
    ).toBe(204)
    expect((await admin.patch(`/api/v1/users/${auditorId}`, {})).statusCode).toBe(400)
  })

  it('ends the access after the last day', async () => {
    // The end date passes (set directly, the API never allows a past date).
    await h.adminSql`update membership set valid_until = current_date - 1 where user_id = ${auditorId}`
    expect((await auditor.get('/api/v1/audit/events')).statusCode).toBe(401)
    expect((await members()).find((m) => m.userId === auditorId)?.expired).toBe(true)
    const login = await new Client(h.app).post('/api/v1/auth/login', {
      email: 'pruefer@finanzamt.example',
      password: 'ein-langes-passwort-1',
    })
    expect(login.statusCode).not.toBe(200)
  })
})
