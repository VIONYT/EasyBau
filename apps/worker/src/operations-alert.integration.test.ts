import { createTenant, openTestDb, type TestDb, testDatabaseUrl } from '@easybau/db/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { alertOperations } from './operations-alert.js'

const quiet = { info: () => undefined, warn: () => undefined }

describe.skipIf(!testDatabaseUrl)('Betriebswarnung per E-Mail (integration)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await openTestDb()
    // backup_run is installation-wide; start from a known state in the test database.
    await db.admin`delete from backup_run`
  })
  afterAll(async () => {
    await db.admin`delete from backup_run`
    await db?.close()
  })

  it('writes to the administrators once per new problem and once when all is fine again', async () => {
    const tenant = await createTenant(db, 'Warnung')
    const options = { smtpEnabled: true, archiveConfigured: false, appName: 'EasyBau' }
    const ours = async () =>
      (await alertOperations(db.app, quiet, options)).find((r) => r.tenantId === tenant.tenantId)
    const mails = () =>
      tenant.run(
        (tx) => tx<{ to: string; subject: string; text: string }[]>`
          select to_address as to, subject, body_text as text from email_message
          where kind = 'operations_alert' order by created_at`,
      )

    await db.admin`
      insert into backup_run (name, status, started_at, finished_at, message)
      values ('easybau-alt', 'ok', now() - interval '31 hours', now() - interval '30 hours', null),
             ('easybau-neu', 'failed', now() - interval '2 hours', now() - interval '1 hour', 'Datenträger voll')`

    // Other test files may check all audit chains at any time (shared test database): check this
    // company's chain first, so the problems below depend only on this test.
    await db.admin`select check_all_audit_chains()`
    const first = await ours()
    expect(first).toMatchObject({ sent: 'alert', recipients: 1 })
    expect(first?.problems).toEqual(['backup_old', 'backup_failed'])
    const [mail] = await mails()
    expect(mail?.to).toMatch(/@example\.test$/)
    expect(mail?.subject).toMatch(/^EasyBau: Bitte Betrieb prüfen \(Warnung \d+\)$/)
    expect(mail?.text).toContain('- Die letzte Sicherung ist fehlgeschlagen (Datenträger voll)')

    // Same problems the next morning: no second e-mail.
    expect(await ours()).toMatchObject({ sent: null })
    expect(await mails()).toHaveLength(1)

    // Fixed: a fresh backup and a checked audit chain → one all-clear e-mail, then quiet.
    await db.admin`
      insert into backup_run (name, status, started_at, finished_at)
      values ('easybau-heute', 'ok', now() - interval '10 minutes', now())`
    await db.admin`select check_all_audit_chains()`
    expect(await ours()).toMatchObject({ problems: [], sent: 'resolved', recipients: 1 })
    expect((await mails()).at(-1)?.subject).toMatch(/Betrieb wieder in Ordnung/)
    expect(await ours()).toMatchObject({ sent: null })
    expect(await mails()).toHaveLength(2)

    // Mandantentrennung (rule 5): another company sees only its own report state.
    const other = await createTenant(db, 'Andere')
    const seen = await other.run(
      (tx) => tx<{ tenantId: string }[]>`select tenant_id as "tenantId" from operations_alert`,
    )
    expect(seen.every((row) => row.tenantId === other.tenantId)).toBe(true)

    // Without SMTP nothing is checked or queued.
    expect(await alertOperations(db.app, quiet, { ...options, smtpEnabled: false })).toEqual([])
  }, 120_000)
})
