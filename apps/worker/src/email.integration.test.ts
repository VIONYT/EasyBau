import { createTenant, openTestDb, type TestDb, testDatabaseUrl } from '@opc/db/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dispatchEmails, type OutgoingMail } from './email.js'

const silent = { warn: () => undefined, debug: () => undefined }

describe.skipIf(!testDatabaseUrl)('e-mail outbox dispatch (integration)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await openTestDb()
    // Other test files share this database: start with an empty outbox.
    await db.admin`delete from email_message`
  })
  afterAll(async () => {
    await db?.close()
  })

  it('sends queued messages of all companies and clears the body afterwards', async () => {
    const a = await createTenant(db, 'Firma A')
    const b = await createTenant(db, 'Firma B')
    for (const [tenant, to] of [
      [a, 'a@example.test'],
      [b, 'b@example.test'],
    ] as const) {
      await tenant.run(
        (tx) => tx`
        insert into email_message (tenant_id, kind, to_address, reply_to, subject, body_text)
        values (${tenant.tenantId}, 'test', ${to}, 'reply@example.test', 'Betreff', 'Text mit Link')`,
      )
    }
    const sent: OutgoingMail[] = []
    const count = await dispatchEmails(
      db.app,
      { send: async (mail) => void sent.push(mail) },
      'ERP <noreply@example.test>',
      silent,
    )
    expect(count).toBe(2)
    expect(sent.map((m) => m.to).sort()).toEqual(['a@example.test', 'b@example.test'])
    expect(sent[0]).toMatchObject({
      from: 'ERP <noreply@example.test>',
      replyTo: 'reply@example.test',
      text: 'Text mit Link',
    })
    const rows = await a.run(
      (tx) => tx<{ status: string; body: string | null }[]>`
      select status, body_text as body from email_message`,
    )
    expect(rows).toEqual([{ status: 'sent', body: null }])
    // Nothing left to send.
    expect(await dispatchEmails(db.app, { send: async () => undefined }, 'x', silent)).toBe(0)
  })

  it('retries with growing pauses and gives up after five attempts', async () => {
    const tenant = await createTenant(db, 'Firma C')
    await tenant.run(
      (tx) => tx`
      insert into email_message (tenant_id, kind, to_address, subject, body_text)
      values (${tenant.tenantId}, 'test', 'c@example.test', 'Betreff', 'geheim')`,
    )
    const failing = { send: async () => Promise.reject(new Error('Verbindung abgelehnt')) }
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await dispatchEmails(db.app, failing, 'x', silent)).toBe(0)
      // Make the retry due immediately for the test.
      await db.admin`update email_message set next_attempt_at = now() where to_address = 'c@example.test'`
    }
    const [row] = await tenant.run(
      (tx) => tx<{ status: string; attempts: number; error: string; body: string | null }[]>`
      select status, attempts, last_error as error, body_text as body from email_message`,
    )
    expect(row).toEqual({
      status: 'failed',
      attempts: 5,
      error: 'Verbindung abgelehnt',
      body: null,
    })
  })
})
