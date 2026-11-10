import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tx } from './index.js'
import {
  createDraftInvoice,
  createProject,
  createTenant,
  expectDbError,
  finalizeDocument,
  openTestDb,
  type TestDb,
  type TestTenant,
  testDatabaseUrl,
} from './test-support.js'

/** Storno: a cancelled invoice is locked for good and its number is never used again. */
describe.skipIf(!testDatabaseUrl)('Storno / cancellation (integration)', () => {
  let db: TestDb
  let a: TestTenant

  beforeAll(async () => {
    db = await openTestDb()
    a = await createTenant(db, 'Storno Bau')
  })

  afterAll(async () => {
    await db?.close()
  })

  const draftCancellation = async (tx: Tx, projectId: string, invoiceId: string) => {
    const [row] = await tx<{ id: string }[]>`
      insert into document (tenant_id, project_id, type, invoice_kind, cancels_document_id, cancel_reason)
      values (${a.tenantId}, ${projectId}, 'invoice', 'cancellation', ${invoiceId}, 'Falscher Empfänger')
      returning id`
    return row?.id as string
  }
  /** Finalizes with a given number, as a faulty code path reusing an old number would. */
  const finalizeWith = (tx: Tx, id: string, number: string) => tx`
    update document set number = ${number}, status = 'finalized', finalized_at = now(),
           content_hash = sha256(convert_to(${number}, 'UTF8')),
           recipient_snapshot = '{"name":"Muster Bau GmbH"}', issuer_snapshot = '{"name":"Test"}'
    where id = ${id}`
  const statusOf = async (tx: Tx, id: string) =>
    (
      await tx<{ status: string; number: string | null }[]>`
      select status, number from document where id = ${id}`
    )[0]

  it('locks the invoice when its cancellation is finalized and keeps both numbers', async () => {
    await a.run(async (tx) => {
      const { projectId } = await createProject(tx, a.tenantId)
      const invoice = await createDraftInvoice(tx, a.tenantId, projectId)
      const number = await finalizeDocument(tx, invoice.documentId)

      const cancellation = await draftCancellation(tx, projectId, invoice.documentId)
      // A draft cancellation does not cancel anything yet.
      expect(await statusOf(tx, invoice.documentId)).toEqual({ status: 'finalized', number })
      // Nobody can mark an invoice as cancelled without a finalized cancellation.
      await expectDbError(
        tx.savepoint(
          (sp) => sp`update document set status = 'cancelled' where id = ${invoice.documentId}`,
        ),
        /only be cancelled by a finalized cancellation/,
      )

      const cancellationNumber = await finalizeDocument(tx, cancellation)
      expect(cancellationNumber).not.toBe(number)
      expect(await statusOf(tx, invoice.documentId)).toEqual({ status: 'cancelled', number })

      // Cancelled stays cancelled, the number stays, nothing can be deleted.
      await expectDbError(
        tx.savepoint(
          (sp) => sp`update document set status = 'sent' where id = ${invoice.documentId}`,
        ),
        /stays cancelled/,
      )
      await expectDbError(
        tx.savepoint(
          (sp) => sp`update document set number = null where id = ${invoice.documentId}`,
        ),
        /immutable/,
      )
      for (const id of [invoice.documentId, cancellation]) {
        await expectDbError(
          tx.savepoint((sp) => sp`delete from document where id = ${id}`),
          /cannot be deleted/,
        )
      }
      // No second cancellation, no cancellation of a cancellation.
      await expectDbError(
        tx.savepoint((sp) => draftCancellation(sp, projectId, invoice.documentId)),
        /already cancelled/,
      )
      await expectDbError(
        tx.savepoint((sp) => draftCancellation(sp, projectId, cancellation)),
        /cannot be cancelled/,
      )
      // No new payments on the cancelled invoice.
      await expectDbError(
        tx.savepoint(
          (sp) => sp`insert into payment (tenant_id, invoice_id, paid_on, amount_cents)
                     values (${a.tenantId}, ${invoice.documentId}, current_date, 1000)`,
        ),
        /is cancelled/,
      )
    })
  })

  it('never issues the number of a cancelled invoice again', async () => {
    await a.run(async (tx) => {
      const { projectId } = await createProject(tx, a.tenantId)
      const invoice = await createDraftInvoice(tx, a.tenantId, projectId)
      const number = await finalizeDocument(tx, invoice.documentId)
      await finalizeDocument(tx, await draftCancellation(tx, projectId, invoice.documentId))

      const next = await createDraftInvoice(tx, a.tenantId, projectId)
      expect(await finalizeDocument(tx, next.documentId)).not.toBe(number)

      // Reusing the number by hand fails, for invoices and for credit notes alike.
      const reuse = await createDraftInvoice(tx, a.tenantId, projectId)
      await expectDbError(
        tx.savepoint((sp) => finalizeWith(sp, reuse.documentId, number)),
        /document_number_uq|document_invoice_number_uq/,
      )
      const [credit] = await tx<{ id: string }[]>`
        insert into document (tenant_id, project_id, type, subject)
        values (${a.tenantId}, ${projectId}, 'credit_note', 'Gutschrift') returning id`
      await expectDbError(
        tx.savepoint((sp) => finalizeWith(sp, credit?.id as string, number)),
        /document_invoice_number_uq/,
      )

      // The counter cannot be turned back, deleted or set to restart without the year.
      await expectDbError(
        tx.savepoint(
          (sp) => sp`update number_sequence set next_value = 101 where kind = 'invoice'`,
        ),
        /must not be decreased/,
      )
      await expectDbError(
        tx.savepoint(
          (sp) =>
            sp`update number_sequence set next_value = 101, current_year = current_year + 1
               where kind = 'invoice'`,
        ),
        /must not be decreased/,
      )
      await expectDbError(
        tx.savepoint(
          (sp) => sp`update number_sequence set reset_yearly = true where kind = 'invoice'`,
        ),
        /with the year in the number/,
      )
      await expectDbError(
        tx.savepoint((sp) => sp`delete from number_sequence where kind = 'invoice'`),
        /must not be deleted/,
      )
      await expectDbError(
        tx.savepoint((sp) => sp`update number_sequence set kind = 'quote' where kind = 'invoice'`),
        /cannot be renamed/,
      )
    })
  })

  it('only cancels finalized invoices of the same project', async () => {
    await a.run(async (tx) => {
      const { projectId } = await createProject(tx, a.tenantId)
      const other = await createProject(tx, a.tenantId)
      const draft = await createDraftInvoice(tx, a.tenantId, projectId)
      await expectDbError(
        tx.savepoint((sp) => draftCancellation(sp, projectId, draft.documentId)),
        /only a finalized invoice/,
      )
      await finalizeDocument(tx, draft.documentId)
      await expectDbError(
        tx.savepoint((sp) => draftCancellation(sp, other.projectId, draft.documentId)),
        /project of the invoice/,
      )
    })
  })
})
