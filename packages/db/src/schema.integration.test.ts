import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

describe.skipIf(!testDatabaseUrl)('database schema (integration)', () => {
  let db: TestDb
  let a: TestTenant
  let b: TestTenant

  beforeAll(async () => {
    db = await openTestDb()
    a = await createTenant(db, 'Betrieb A')
    b = await createTenant(db, 'Betrieb B')
    await a.run(async (tx) => {
      const { projectId } = await createProject(tx, a.tenantId)
      await createDraftInvoice(tx, a.tenantId, projectId)
    })
  })

  afterAll(async () => {
    await db?.close()
  })

  describe('tenant isolation (rule 5)', () => {
    it('runtime role is neither superuser nor allowed to bypass RLS', async () => {
      const [role] = await db.app<
        { rolsuper: boolean; rolbypassrls: boolean; current_user: string }[]
      >`
        select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`
      expect(role).toEqual({ current_user: 'opc_app', rolsuper: false, rolbypassrls: false })
    })

    it('every table with tenant_id has forced RLS and a policy', async () => {
      const rows = await db.admin<
        { table: string; rls: boolean; forced: boolean; policies: number }[]
      >`
        select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
               (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
        from pg_class c
        join pg_attribute att on att.attrelid = c.oid and att.attname = 'tenant_id' and not att.attisdropped
        where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace`
      expect(rows.length).toBeGreaterThan(35)
      const unprotected = rows
        .filter((r) => !r.rls || !r.forced || r.policies === 0)
        .map((r) => r.table)
      expect(unprotected).toEqual([])
    })

    it('no tenant table leaks rows of another tenant', async () => {
      const tables = await db.admin<{ table: string }[]>`
        select c.relname as table from pg_class c
        join pg_attribute att on att.attrelid = c.oid and att.attname = 'tenant_id' and not att.attisdropped
        where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace order by 1`
      for (const tenant of [a, b]) {
        await tenant.run(async (tx) => {
          for (const { table } of tables) {
            const [row] = await tx.unsafe<{ foreign: number }[]>(
              `select count(*)::int as foreign from ${table} where tenant_id is distinct from current_tenant_id()`,
            )
            expect(row?.foreign, `table ${table}`).toBe(0)
          }
        })
      }
    })

    it('tenant B can neither read, write into nor change data of tenant A', async () => {
      const visible = await b.run((tx) => tx`select id from contact`)
      expect(visible).toHaveLength(0)
      const [contactOfA] = await a.run((tx) => tx<{ id: string }[]>`select id from contact limit 1`)
      const updated = await b.run(
        (tx) => tx`update contact set description = 'x' where id = ${contactOfA?.id as string}`,
      )
      expect(updated.count).toBe(0)
      await expectDbError(
        b.run(
          (tx) => tx`insert into contact (tenant_id, kind, organization_name)
                     values (${a.tenantId}, 'organization', 'Fremd')`,
        ),
        /row-level security/,
      )
    })

    it('without tenant context no tenant data is visible', async () => {
      const rows = await db.app`select id from contact`
      expect(rows).toHaveLength(0)
    })
  })

  describe('tenant defaults', () => {
    it('seeds the construction units with UN/ECE codes', async () => {
      const units = await a.run(
        (tx) => tx<{ symbol: string; unece_code: string }[]>`
        select symbol, unece_code from unit order by symbol`,
      )
      expect(units).toHaveLength(20)
      const codes = Object.fromEntries(units.map((u) => [u.symbol, u.unece_code]))
      expect(codes).toMatchObject({
        'm²': 'MTK',
        Std: 'HUR',
        'Stk.': 'H87',
        psch: 'LS',
        pa: 'ANN',
        Lfm: 'LM',
      })
    })

    it('seeds roles, report templates and sequences, idempotently', async () => {
      await a.run((tx) => tx`select seed_tenant_defaults()`)
      const [counts] = await a.run(
        (tx) => tx<{ roles: number; templates: number; billable: number; seqs: number }[]>`
        select (select count(*)::int from role) as roles,
               (select count(*)::int from report_template) as templates,
               (select count(*)::int from report_template where billable) as billable,
               (select count(*)::int from number_sequence) as seqs`,
      )
      expect(counts).toEqual({ roles: 6, templates: 11, billable: 4, seqs: 8 })
    })

    it('protects system units', async () => {
      await expectDbError(
        a.run((tx) => tx`delete from unit where symbol = 'm²'`),
        /system unit/,
      )
      await expectDbError(
        a.run((tx) => tx`update unit set unece_code = 'XXX' where symbol = 'm²'`),
        /system unit/,
      )
    })
  })

  describe('number sequences (rule 3)', () => {
    it('formats numbers with prefix and minimum length', async () => {
      const [row] = await b.run(
        (tx) => tx<{ n: string; c: string }[]>`
        select next_number('contact') as c, next_number('project') as n`,
      )
      expect(row).toEqual({ c: 'K-10001', n: 'P-00101' })
    })

    it('is gapless and unique under parallel load', async () => {
      const tenant = await createTenant(db, 'Parallel')
      const numbers = await Promise.all(
        Array.from({ length: 25 }, () =>
          tenant.run(async (tx) => {
            const [row] = await tx<{ n: string }[]>`select next_number('invoice') as n`
            return row?.n as string
          }),
        ),
      )
      const sorted = [...numbers].sort()
      expect(new Set(numbers).size).toBe(25)
      expect(sorted[0]).toBe('R-00101')
      expect(sorted[24]).toBe('R-00125')
    })

    it('does not consume a number when the transaction rolls back', async () => {
      const tenant = await createTenant(db, 'Rollback')
      await expectDbError(
        tenant.run(async (tx) => {
          await tx`select next_number('invoice')`
          throw new Error('finalize failed')
        }),
        /finalize failed/,
      )
      const [row] = await tenant.run(
        (tx) => tx<{ n: string }[]>`select next_number('invoice') as n`,
      )
      expect(row?.n).toBe('R-00101')
    })

    it('supports year prefix with yearly reset', async () => {
      const tenant = await createTenant(db, 'Jahr')
      const [row] = await tenant.run(async (tx) => {
        await tx`update number_sequence set pattern = 'A-{Jahr}-{Nummer}', reset_yearly = true where kind = 'quote'`
        await tx`select next_number('quote', '2026-12-30')`
        return tx<{ n: string }[]>`select next_number('quote', '2027-01-04') as n`
      })
      expect(row?.n).toBe('A-2027-00101')
    })

    it('never decreases the invoice counter', async () => {
      await expectDbError(
        b.run((tx) => tx`update number_sequence set next_value = 1 where kind = 'invoice'`),
        /must not be decreased/,
      )
    })
  })

  describe('immutability of finalized documents (rule 2)', () => {
    let documentId: string
    let itemId: string

    beforeAll(async () => {
      await a.run(async (tx) => {
        const { projectId } = await createProject(tx, a.tenantId)
        const draft = await createDraftInvoice(tx, a.tenantId, projectId)
        documentId = draft.documentId
        itemId = draft.itemId
        await tx`insert into document_tax_line (tenant_id, document_id, tax_category, rate_percent, net_cents, tax_cents)
                 values (${a.tenantId}, ${documentId}, 'S', 19, 56250, 10688)`
        await finalizeDocument(tx, documentId)
      })
    })

    it('rejects changes to content', async () => {
      await expectDbError(
        a.run((tx) => tx`update document set subject = 'geändert' where id = ${documentId}`),
        /immutable/,
      )
      await expectDbError(
        a.run((tx) => tx`update document set gross_total_cents = 1 where id = ${documentId}`),
        /immutable/,
      )
    })

    it('allows workflow status changes but never back to draft', async () => {
      await a.run(
        (tx) => tx`update document set status = 'sent', sent_at = now() where id = ${documentId}`,
      )
      await expectDbError(
        a.run((tx) => tx`update document set status = 'draft' where id = ${documentId}`),
        /draft/,
      )
    })

    it('rejects deletion', async () => {
      await expectDbError(
        a.run((tx) => tx`delete from document where id = ${documentId}`),
        /cannot be deleted/,
      )
    })

    it('rejects adding, changing or removing items and tax lines', async () => {
      await expectDbError(
        a.run((tx) => tx`update document_item set total_cents = 1 where id = ${itemId}`),
        /finalized document/,
      )
      await expectDbError(
        a.run((tx) => tx`delete from document_item where id = ${itemId}`),
        /finalized document/,
      )
      await expectDbError(
        a.run(
          (tx) => tx`insert into document_item (tenant_id, document_id, position_type, short_text)
                         values (${a.tenantId}, ${documentId}, 'text', 'Nachtrag')`,
        ),
        /finalized document/,
      )
      await expectDbError(
        a.run((tx) => tx`delete from document_tax_line where document_id = ${documentId}`),
        /finalized document/,
      )
    })

    it('keeps archived artifacts insert-only', async () => {
      // Rule 8: an e-invoice is archived only with a passed validation.
      await expectDbError(
        a.run(
          (
            tx,
          ) => tx`insert into document_artifact (tenant_id, document_id, kind, format, storage_key,
            sha256, size_bytes, mime_type, locked_until)
          values (${a.tenantId}, ${documentId}, 'zugferd_pdf', 'zugferd', ${`archive/${documentId}.pdf`},
            sha256('pdf'::bytea), 1234, 'application/pdf', '2037-12-31')`,
        ),
        /document_artifact_einvoice_validated/,
      )
      await a.run(
        (tx) => tx`insert into document_artifact (tenant_id, document_id, kind, format, storage_key,
          sha256, size_bytes, mime_type, validated_at, locked_until)
        values (${a.tenantId}, ${documentId}, 'zugferd_pdf', 'zugferd', ${`archive/${documentId}.pdf`},
          sha256('pdf'::bytea), 1234, 'application/pdf', now(), '2037-12-31')`,
      )
      await expectDbError(
        a.run((tx) => tx`delete from document_artifact where document_id = ${documentId}`),
        /permission denied/,
      )
    })

    it('still allows deleting drafts', async () => {
      const deleted = await a.run(async (tx) => {
        const { projectId } = await createProject(tx, a.tenantId)
        const draft = await createDraftInvoice(tx, a.tenantId, projectId)
        return tx`delete from document where id = ${draft.documentId}`
      })
      expect(deleted.count).toBe(1)
    })

    it('requires number, snapshots and hash when finalizing', async () => {
      await expectDbError(
        a.run(async (tx) => {
          const { projectId } = await createProject(tx, a.tenantId)
          const draft = await createDraftInvoice(tx, a.tenantId, projectId)
          await tx`update document set finalized_at = now(), status = 'finalized' where id = ${draft.documentId}`
        }),
        /check constraint/,
      )
    })
  })

  describe('audit log (rule 6)', () => {
    it('records changes with the acting user in the same transaction', async () => {
      const [event] = await a.run(async (tx) => {
        const [c] = await tx<{ id: string }[]>`
          insert into contact (tenant_id, kind, last_name) values (${a.tenantId}, 'person', 'Audit') returning id`
        await tx`update contact set first_name = 'Anna' where id = ${c?.id as string}`
        return tx<
          { action: string; actor_user_id: string; before: { first_name: string | null } }[]
        >`
          select action, actor_user_id, before from audit_event
          where entity = 'contact' and entity_id = ${c?.id as string} order by seq desc limit 1`
      })
      expect(event?.action).toBe('update')
      expect(event?.actor_user_id).toBe(a.userId)
      expect(event?.before.first_name).toBeNull()
    })

    it('keeps an intact hash chain per tenant', async () => {
      const [row] = await a.run(
        (tx) => tx<{ broken: string | null; n: number }[]>`
        select verify_audit_chain(current_tenant_id()) as broken,
               (select count(*)::int from audit_event) as n`,
      )
      expect(row?.n).toBeGreaterThan(5)
      expect(row?.broken).toBeNull()
    })

    it('is append-only for the application', async () => {
      await expectDbError(
        a.run((tx) => tx`update audit_event set action = 'x'`),
        /permission denied/,
      )
      await expectDbError(
        a.run((tx) => tx`delete from audit_event`),
        /permission denied/,
      )
    })

    it('detects tampering even by a database administrator', async () => {
      // A superuser can switch off the trigger; the hash chain still reveals the change.
      // The transaction is rolled back so the tampering does not persist.
      const broken = await db.admin
        .begin(async (tx) => {
          await tx`alter table audit_event disable trigger trg_audit_immutable`
          await tx`update audit_event set after = '{"tampered":true}'
                   where tenant_id = ${a.tenantId} and seq = 2`
          const [row] = await tx<{ broken: string | null }[]>`
            select verify_audit_chain(${a.tenantId}::uuid) as broken`
          throw Object.assign(new Error('rollback'), { broken: row?.broken })
        })
        .catch((error: Error & { broken?: string }) => error.broken)
      expect(broken).toBe('2')
      const [after] = await db.admin<{ broken: string | null }[]>`
        select verify_audit_chain(${a.tenantId}::uuid) as broken`
      expect(after?.broken).toBeNull()
    })
  })

  describe('measurements and reports (rule 12)', () => {
    it('locks billed measurement lines and signed sheets', async () => {
      await a.run(async (tx) => {
        const { projectId } = await createProject(tx, a.tenantId)
        const invoice = await createDraftInvoice(tx, a.tenantId, projectId)
        const [sheet] = await tx<{ id: string }[]>`
          insert into measurement_sheet (tenant_id, project_id, kind, title)
          values (${a.tenantId}, ${projectId}, 'performance', 'Bad EG') returning id`
        const [line] = await tx<{ id: string }[]>`
          insert into measurement_line (tenant_id, sheet_id, document_item_id, formula, result_qty)
          values (${a.tenantId}, ${sheet?.id as string}, ${invoice.itemId}, '4,25*2,60-0,885*2,01', 9.2711)
          returning id`
        await finalizeDocument(tx, invoice.documentId)
        await tx`update measurement_line set locked_by_invoice_id = ${invoice.documentId}
                 where id = ${line?.id as string}`
        await expectDbError(
          tx.savepoint(
            (sp) =>
              sp`update measurement_line set formula = '5*2' where id = ${line?.id as string}`,
          ),
          /billed/,
        )
        await expectDbError(
          tx.savepoint((sp) => sp`delete from measurement_line where id = ${line?.id as string}`),
          /billed/,
        )
        await tx`update measurement_sheet set status = 'signed', signed_at = now() where id = ${sheet?.id as string}`
        await expectDbError(
          tx.savepoint(
            (sp) => sp`insert into measurement_line (tenant_id, sheet_id, formula, result_qty)
             values (${a.tenantId}, ${sheet?.id as string}, '1', 1)`,
          ),
          /signed/,
        )
      })
    })

    it('locks signed reports', async () => {
      await expectDbError(
        a.run(async (tx) => {
          const { projectId } = await createProject(tx, a.tenantId)
          const [report] = await tx<{ id: string }[]>`
            insert into report (tenant_id, project_id, template_id, status)
            select ${a.tenantId}, ${projectId}, id, 'signed' from report_template where key = 'daywork_report'
            returning id`
          await tx`update report set data = '{"notes":"x"}' where id = ${report?.id as string}`
        }),
        /signed or billed/,
      )
    })
  })

  describe('receivables', () => {
    it('accepts payments only for finalized invoices and protects exported ones', async () => {
      await a.run(async (tx) => {
        const { projectId } = await createProject(tx, a.tenantId)
        const invoice = await createDraftInvoice(tx, a.tenantId, projectId)
        await expectDbError(
          tx.savepoint(
            (sp) => sp`insert into payment (tenant_id, invoice_id, paid_on, amount_cents)
             values (${a.tenantId}, ${invoice.documentId}, current_date, 1000)`,
          ),
          /finalized invoice/,
        )
        await finalizeDocument(tx, invoice.documentId)
        const [payment] = await tx<{ id: string }[]>`
          insert into payment (tenant_id, invoice_id, paid_on, amount_cents)
          values (${a.tenantId}, ${invoice.documentId}, current_date, 50000) returning id`
        await tx`insert into receivable_adjustment (tenant_id, invoice_id, kind, amount_cents)
                 values (${a.tenantId}, ${invoice.documentId}, 'cash_discount', 1338)`
        const [balance] = await tx<{ open_amount_cents: string }[]>`
          select open_amount_cents from invoice_balance where invoice_id = ${invoice.documentId}`
        expect(Number(balance?.open_amount_cents)).toBe(66938 - 50000 - 1338)

        await tx`update payment set exported_at = now() where id = ${payment?.id as string}`
        await expectDbError(
          tx.savepoint(
            (sp) => sp`update payment set amount_cents = 1 where id = ${payment?.id as string}`,
          ),
          /exported/,
        )
      })
    })

    it('enforces the dunning order reminder → first → final', async () => {
      await a.run(async (tx) => {
        const { projectId } = await createProject(tx, a.tenantId)
        const invoice = await createDraftInvoice(tx, a.tenantId, projectId)
        await finalizeDocument(tx, invoice.documentId)
        await expectDbError(
          tx.savepoint(
            (
              sp,
            ) => sp`insert into dunning_notice (tenant_id, invoice_id, level, due_date, open_amount_cents)
             values (${a.tenantId}, ${invoice.documentId}, 'first', current_date + 7, 66938)`,
          ),
          /requires level reminder/,
        )
        await tx`insert into dunning_notice (tenant_id, invoice_id, level, due_date, open_amount_cents)
                 values (${a.tenantId}, ${invoice.documentId}, 'reminder', current_date + 7, 66938)`
        await tx`insert into dunning_notice (tenant_id, invoice_id, level, due_date, open_amount_cents)
                 values (${a.tenantId}, ${invoice.documentId}, 'first', current_date + 14, 66938)`
      })
    })
  })

  describe('helpers', () => {
    it('generates time-ordered UUIDv7', async () => {
      const rows = await db.admin<
        { id: string }[]
      >`select uuid_v7()::text as id from generate_series(1, 3)`
      for (const { id } of rows) expect(id[14]).toBe('7')
    })
  })
})
