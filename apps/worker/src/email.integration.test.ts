import {
  createDraftInvoice,
  createProject,
  createTenant,
  finalizeDocument,
  openTestDb,
  type TestDb,
  testDatabaseUrl,
} from '@opc/db/test-support'
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

  it('attaches archived originals and fails while one is not readable', async () => {
    const tenant = await createTenant(db, 'Firma D')
    const messageId = await tenant.run(async (tx) => {
      const { projectId } = await createProject(tx, tenant.tenantId)
      const { documentId } = await createDraftInvoice(tx, tenant.tenantId, projectId)
      await finalizeDocument(tx, documentId)
      const [artifact] = await tx<{ id: string }[]>`
        insert into document_artifact (tenant_id, document_id, kind, storage_key, sha256, size_bytes,
                                       mime_type, locked_until)
        values (${tenant.tenantId}, ${documentId}, 'pdf', 'key/mahnung', ${Buffer.alloc(32)}, 4,
                'application/pdf', '2032-12-31')
        returning id`
      const [message] = await tx<{ id: string }[]>`
        insert into email_message (tenant_id, kind, to_address, subject, body_text)
        values (${tenant.tenantId}, 'dunning', 'd@example.test', 'Mahnung', 'Anbei')
        returning id`
      await tx`
        insert into email_attachment (tenant_id, email_message_id, artifact_id, filename)
        values (${tenant.tenantId}, ${message?.id as string}, ${artifact?.id as string}, 'Mahnung_R-1.pdf')`
      return message?.id as string
    })
    const sent: OutgoingMail[] = []
    const transport = { send: async (mail: OutgoingMail) => void sent.push(mail) }
    // Not readable (e.g. working copy missing and no archive): retried later, nothing sent.
    expect(await dispatchEmails(db.app, transport, 'x', silent, 10, async () => null)).toBe(0)
    await db.admin`update email_message set next_attempt_at = now() where id = ${messageId}`
    const reader = async (key: string): Promise<Buffer | null> =>
      key === 'key/mahnung' ? Buffer.from('%PDF') : null
    expect(await dispatchEmails(db.app, transport, 'x', silent, 10, reader)).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.attachments).toEqual([
      { filename: 'Mahnung_R-1.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' },
    ])
  })
})
