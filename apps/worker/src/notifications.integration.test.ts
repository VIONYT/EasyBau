import { createTenant, openTestDb, type TestDb, testDatabaseUrl } from '@easybau/db/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { purgeReadNotifications } from './notifications.js'

describe.skipIf(!testDatabaseUrl)('Benachrichtigungen aufräumen (integration)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await openTestDb()
  })
  afterAll(async () => {
    await db?.close()
  })

  it('deletes read notifications after 90 days, keeps unread, recent and overdue ones', async () => {
    const tenant = await createTenant(db, 'Aufräumen')
    const add = (kind: string, readDaysAgo: number | null) =>
      tenant.run(
        (tx) => tx<{ id: string }[]>`
          insert into notification (tenant_id, user_id, kind, ref_id, title, route, read_at)
          values (${tenant.tenantId}, ${tenant.userId}, ${kind}, uuid_v7(), 'Hinweis', '/projekte',
                  ${readDaysAgo === null ? null : tx`now() - make_interval(days => ${readDaysAgo})`})
          returning id`,
      )
    const [old] = await add('report_signed', 120)
    const [recent] = await add('report_signed', 10)
    const [unread] = await add('change_order_decided', null)
    const [overdue] = await add('invoice_overdue', 200)
    const removed = await purgeReadNotifications(db.app, { info: () => undefined })
    expect(removed).toBeGreaterThanOrEqual(1)
    const left = await tenant.run(
      (tx) => tx<{ id: string }[]>`select id from notification order by id`,
    )
    const ids = left.map((r) => r.id)
    expect(ids).not.toContain(old?.id)
    expect(ids).toEqual(expect.arrayContaining([recent?.id, unread?.id, overdue?.id]))
    await expect(purgeReadNotifications(db.app, { info: () => undefined }, 7)).rejects.toThrow(
      /at least 30 days/,
    )
  })

  it('forgets Idempotency-Keys and their stored answers after a day', async () => {
    const tenant = await createTenant(db, 'Schlüssel')
    await tenant.run(
      (tx) => tx`
        insert into idempotency_key (tenant_id, key, request_hash, response_status, response_body, created_at)
        values (${tenant.tenantId}, 'alter-schluessel', '\\x00', 201, '{"name":"Erna Muster"}', now() - interval '25 hours'),
               (${tenant.tenantId}, 'neuer-schluessel', '\\x00', 201, '{}', now())`,
    )
    await purgeReadNotifications(db.app, { info: () => undefined })
    const left = await tenant.run((tx) => tx<{ key: string }[]>`select key from idempotency_key`)
    expect(left.map((r) => r.key)).toEqual(['neuer-schluessel'])
  })
})
