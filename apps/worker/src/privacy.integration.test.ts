import { createTenant, openTestDb, type TestDb, testDatabaseUrl } from '@easybau/db/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eraseExpiredContacts } from './privacy.js'

const quiet = { info: () => undefined }

describe.skipIf(!testDatabaseUrl)('Löschkonzept: Sperrfrist abgelaufen (integration)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await openTestDb()
  })
  afterAll(async () => {
    await db?.close()
  })

  it('erases blocked contacts the day after their retention period and only those', async () => {
    const tenant = await createTenant(db, 'Sperrfrist')
    const add = (name: string, blockedUntil: string | null) =>
      tenant.run(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into contact (tenant_id, kind, first_name, last_name, blocked_at, blocked_until)
          values (${tenant.tenantId}, 'person', 'Erna', ${name},
                  ${blockedUntil ? tx`now()` : null}, ${blockedUntil})
          returning id`
        await tx`insert into contact_channel (tenant_id, contact_id, kind, value)
                 values (${tenant.tenantId}, ${row?.id as string}, 'email', ${`${name}@example.test`})`
        return row?.id as string
      })
    const expired = await add('Abgelaufen', '2020-12-31')
    const running = await add('Läuft', '2099-12-31')
    const normal = await add('Normal', null)

    expect(await eraseExpiredContacts(db.app, quiet)).toBeGreaterThanOrEqual(1)
    const rows = await tenant.run(
      (tx) => tx<{ id: string; lastName: string; erased: boolean; channels: number }[]>`
        select id, last_name as "lastName", erased_at is not null as erased,
               (select count(*)::int from contact_channel ch where ch.contact_id = c.id) as channels
        from contact c where id in (${expired}, ${running}, ${normal})`,
    )
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId[expired]).toMatchObject({
      lastName: 'Gelöschter Kontakt',
      erased: true,
      channels: 0,
    })
    expect(byId[running]).toMatchObject({ lastName: 'Läuft', erased: false, channels: 1 })
    expect(byId[normal]).toMatchObject({ lastName: 'Normal', erased: false, channels: 1 })
    const [event] = await tenant.run(
      (tx) => tx<{ action: string }[]>`
        select action from audit_event where entity = 'contact' and entity_id = ${expired}
          and action = 'privacy_erase'`,
    )
    expect(event?.action).toBe('privacy_erase')
    // Idempotent: a second run finds nothing more of this company.
    await eraseExpiredContacts(db.app, quiet)
    await expect(
      tenant.run((tx) => tx`update contact set first_name = 'Erna' where id = ${expired}`),
    ).rejects.toThrow(/is erased/)
  })
})
