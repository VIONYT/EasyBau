import type { OperationsStatus } from '@opc/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

describe.skipIf(!process.env.DATABASE_URL)('Betriebs-Check (integration)', () => {
  let h: Harness
  let admin: Client
  let worker: Client

  beforeAll(async () => {
    h = await createHarness({ requireAdminMfa: false })
    admin = new Client(h.app)
    await admin.post('/api/v1/setup', {
      setupToken: h.setupToken,
      company: { name: 'Betrieb Bau GmbH' },
      admin: {
        email: 'chef@example.test',
        password: 'ein-sehr-langes-passwort',
        displayName: 'Chef',
      },
    })
    const invite = await admin.post('/api/v1/invitations', {
      email: 'monteur@example.test',
      roleKey: 'team_member',
    })
    worker = new Client(h.app)
    await worker.post('/api/v1/invitations/accept', {
      token: new URL(invite.json().acceptUrl).hash.slice(1),
      displayName: 'Monteur',
      password: 'monteur-passwort-1',
    })
  })

  afterAll(async () => {
    await h?.close()
  })

  it('reports no backup on a fresh installation', async () => {
    const res = await admin.get('/api/v1/settings/operations')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({
      backup: { lastSuccess: null, recent: [] },
      // No check of the audit chain yet: the nightly job has not run.
      audit: { lastCheckAt: null, problem: null, brokenSeq: null, events: 0, stale: true },
      email: { enabled: false, queued: 0, failed: 0 },
      security: { requireAdminMfa: false, https: true },
      einvoice: { configured: true, reachable: true },
      archive: {
        configured: false,
        bucket: null,
        reachable: false,
        objectLock: false,
        mode: null,
        pending: 0,
        oldestPendingAt: null,
        failing: 0,
        lastError: null,
        verify: {
          lastCheckAt: null,
          checked30d: 0,
          restored30d: 0,
          lost: 0,
          unchecked: 0,
          request: null,
        },
      },
    })
    // Without an archive there is nothing to reconcile.
    expect((await admin.post('/api/v1/settings/operations/archive-verify', {})).statusCode).toBe(
      409,
    )
  })

  it('shows the runs written by the backup service', async () => {
    // The backup service writes with the database owner (infra/backup/backup.sh).
    await h.adminSql`
      insert into backup_run (name, status, started_at, finished_at, db_bytes, files_bytes, message) values
        ('2026-11-07_023000', 'ok', now() - interval '2 days', now() - interval '2 days', 1200, 34000, null),
        ('2026-11-08_023000', 'failed', now() - interval '1 day', now() - interval '1 day', null, null, 'No space left on device')`
    const status = (await admin.get('/api/v1/settings/operations')).json() as OperationsStatus
    expect(status.backup.lastSuccess).toMatchObject({
      name: '2026-11-07_023000',
      status: 'ok',
      dbBytes: 1200,
      filesBytes: 34000,
    })
    expect(status.backup.recent.map((r) => [r.name, r.status, r.message])).toEqual([
      ['2026-11-08_023000', 'failed', 'No space left on device'],
      ['2026-11-07_023000', 'ok', null],
    ])
    expect(status.backup.lastSuccess?.offsite).toBeNull()
  })

  it('shows the state of the encrypted copy off site (ADR 0011)', async () => {
    await h.adminSql`
      insert into backup_run (name, status, started_at, finished_at, offsite_status, offsite_at,
                              offsite_target, offsite_message) values
        ('2026-11-09_023000', 'ok', now(), now(), 'ok', now(), 's3:https://s3.example.com/sicherung', null)`
    const status = (await admin.get('/api/v1/settings/operations')).json() as OperationsStatus
    expect(status.backup.lastSuccess?.offsite).toMatchObject({
      status: 'ok',
      target: 's3:https://s3.example.com/sicherung',
      message: null,
    })
    expect(status.backup.lastSuccess?.offsite?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('lets the application only read the backup log', async () => {
    await expect(
      h.sql`insert into backup_run (name, status, started_at) values ('x', 'ok', now())`,
    ).rejects.toThrow(/permission denied/)
  })

  it('is closed to site roles', async () => {
    expect((await worker.get('/api/v1/settings/operations')).statusCode).toBe(403)
  })
})
