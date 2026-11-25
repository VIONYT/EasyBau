import {
  createDraftInvoice,
  createProject,
  createTenant,
  finalizeDocument,
  openTestDb,
  type TestDb,
  testDatabaseUrl,
} from '@easybau/db/test-support'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dispatchEmails, type OutgoingMail } from './email.js'

const silent = { warn: () => undefined, debug: () => undefined }

describe.skipIf(!testDatabaseUrl)('e-mail outbox dispatch (integration)', () => {
  let db: TestDb
  beforeAll(async () => {
    // Own database: the outbox is shared by all companies, and other test files queue mails too.
    db = await openTestDb({ isolated: true })
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
    const all: OutgoingMail[] = []
    await dispatchEmails(
      db.app,
      { send: async (mail) => void all.push(mail) },
      'ERP <noreply@example.test>',
      silent,
      500,
    )
    // Other test files queue mails in the shared test database too: look only at these two.
    const sent = all.filter((m) => ['a@example.test', 'b@example.test'].includes(m.to))
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
    // Nothing of these two is sent again.
    const again: OutgoingMail[] = []
    await dispatchEmails(db.app, { send: async (mail) => void again.push(mail) }, 'x', silent, 500)
    expect(again.filter((m) => ['a@example.test', 'b@example.test'].includes(m.to))).toEqual([])
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
      expect(await dispatchEmails(db.app, failing, 'x', silent, 500)).toBe(0)
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
    // Other test files queue mails in the shared test database too: look only at this one.
    const ours = () => sent.filter((m) => m.subject === 'Mahnung' && m.to === 'd@example.test')
    // Not readable (e.g. working copy missing and no archive): retried later, nothing sent.
    await dispatchEmails(db.app, transport, 'x', silent, 100, async () => null)
    expect(ours()).toHaveLength(0)
    const [waiting] = await db.admin<{ status: string }[]>`
      select status from email_message where id = ${messageId}`
    expect(waiting?.status).toBe('queued')
    await db.admin`update email_message set next_attempt_at = now() where id = ${messageId}`
    const reader = async (key: string): Promise<Buffer | null> =>
      key === 'key/mahnung' ? Buffer.from('%PDF') : null
    await dispatchEmails(db.app, transport, 'x', silent, 100, reader)
    expect(ours()).toHaveLength(1)
    expect(ours()[0]?.attachments).toEqual([
      { filename: 'Mahnung_R-1.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' },
    ])
  })

  it('sends a document with CC/BCC and marks it as sent once the server accepted it', async () => {
    const tenant = await createTenant(db, 'Firma E')
    const documentId = await tenant.run(async (tx) => {
      const { projectId } = await createProject(tx, tenant.tenantId)
      const { documentId } = await createDraftInvoice(tx, tenant.tenantId, projectId)
      await finalizeDocument(tx, documentId)
      await tx`
        insert into email_message (tenant_id, kind, to_address, subject, body_text, document_id,
                                   cc_addresses, bcc_addresses)
        values (${tenant.tenantId}, 'document', 'kunde@example.test', 'Rechnung', 'Anbei', ${documentId},
                ${['bauleitung@example.test']}, ${['archiv@example.test']})`
      return documentId
    })
    const sent: OutgoingMail[] = []
    const failing = { send: async () => Promise.reject(new Error('Postfach voll')) }
    expect(await dispatchEmails(db.app, failing, 'x', silent)).toBe(0)
    const status = async () =>
      (
        await tenant.run(
          (tx) => tx<{ status: string; sent: boolean }[]>`
            select status, sent_at is not null as sent from document where id = ${documentId}`,
        )
      )[0]
    // Not accepted by the server: the document stays "finalized".
    expect(await status()).toEqual({ status: 'finalized', sent: false })
    await db.admin`update email_message set next_attempt_at = now() where document_id = ${documentId}`
    expect(
      await dispatchEmails(db.app, { send: async (mail) => void sent.push(mail) }, 'x', silent),
    ).toBe(1)
    expect(sent[0]).toMatchObject({
      to: 'kunde@example.test',
      cc: ['bauleitung@example.test'],
      bcc: ['archiv@example.test'],
    })
    expect(await status()).toEqual({ status: 'sent', sent: true })
    const audit = await tenant.run(
      (tx) => tx<{ status: string }[]>`
        select after ->> 'status' as status from audit_event
        where entity = 'document' and entity_id = ${documentId} and action = 'update'
        order by seq desc limit 1`,
    )
    expect(audit).toEqual([{ status: 'sent' }])
  })
})
