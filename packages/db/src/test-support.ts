import { createSql, migrate, type Sql, type Tx, withTenant } from './index.js'

/** Shared helpers for database integration tests (not exported from the package entry). */
export const testDatabaseUrl = process.env.DATABASE_URL

export interface TestDb {
  admin: Sql
  app: Sql
  close: () => Promise<void>
}

export async function openTestDb(): Promise<TestDb> {
  const url = testDatabaseUrl as string
  const admin = createSql({ DATABASE_URL: url, DATABASE_POOL_MAX: 3 }, { mode: 'admin' })
  await migrate(admin)
  const app = createSql({ DATABASE_URL: url, DATABASE_POOL_MAX: 10 })
  return {
    admin,
    app,
    close: async () => {
      await app.end({ timeout: 5 })
      await admin.end({ timeout: 5 })
    },
  }
}

export interface TestTenant {
  tenantId: string
  userId: string
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>
}

let counter = 0

/** Creates a tenant with default data and an admin user, using the restricted runtime role. */
export async function createTenant(db: TestDb, name = 'Testbetrieb'): Promise<TestTenant> {
  counter += 1
  const [ids] = await db.admin<{ tenant: string; user: string }[]>`
    select uuid_v7() as tenant, uuid_v7() as user`
  const tenantId = ids?.tenant as string
  const userId = ids?.user as string
  await db.app`insert into app_user (id, email, display_name)
    values (${userId}, ${`user-${Date.now()}-${counter}@example.test`}, 'Test User')`
  const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(db.app, { tenantId, userId }, fn)
  await run(async (tx) => {
    await tx`insert into tenant (id, name) values (${tenantId}, ${`${name} ${counter}`})`
    await tx`select seed_tenant_defaults()`
    await tx`insert into membership (tenant_id, user_id, role_id)
      select ${tenantId}, ${userId}, id from role where key = 'admin'`
  })
  return { tenantId, userId, run }
}

/** Creates a customer and a project; returns their ids. */
export async function createProject(tx: Tx, tenantId: string) {
  const [contact] = await tx<{ id: string }[]>`
    insert into contact (tenant_id, kind, organization_name)
    values (${tenantId}, 'organization', 'Muster Bau GmbH') returning id`
  const [project] = await tx<{ id: string }[]>`
    insert into project (tenant_id, name, customer_id, site_city)
    values (${tenantId}, 'Sanierung Bad', ${contact?.id as string}, 'Hannover') returning id`
  return { contactId: contact?.id as string, projectId: project?.id as string }
}

/** Creates a draft invoice with one item. */
export async function createDraftInvoice(tx: Tx, tenantId: string, projectId: string) {
  const [unit] = await tx<{ id: string }[]>`select id from unit where symbol = 'm²'`
  const [doc] = await tx<{ id: string }[]>`
    insert into document (tenant_id, project_id, type, invoice_kind, subject)
    values (${tenantId}, ${projectId}, 'invoice', 'standard', 'Fliesenarbeiten') returning id`
  const [item] = await tx<{ id: string }[]>`
    insert into document_item (tenant_id, document_id, position_type, oz, quantity, unit_id,
      unit_symbol, unit_unece_code, short_text, unit_price_cents, total_cents, tax_rate_percent, tax_category)
    values (${tenantId}, ${doc?.id as string}, 'item', '1', 12.5, ${unit?.id as string}, 'm²', 'MTK',
      'Bodenfliesen verlegen', 4500, 56250, 19, 'S') returning id`
  return { documentId: doc?.id as string, itemId: item?.id as string }
}

/** Finalizes a document the way the application will: number, snapshots, hash, timestamp. */
export async function finalizeDocument(
  tx: Tx,
  documentId: string,
  kind = 'invoice',
): Promise<string> {
  const [row] = await tx<{ number: string }[]>`select next_number(${kind}) as number`
  const number = row?.number as string
  await tx`update document set
      number = ${number},
      status = 'finalized',
      finalized_at = now(),
      content_hash = sha256(convert_to(${number}, 'UTF8')),
      recipient_snapshot = '{"name":"Muster Bau GmbH"}',
      issuer_snapshot = '{"name":"Testbetrieb"}',
      net_total_cents = 56250, tax_total_cents = 10688, gross_total_cents = 66938
    where id = ${documentId}`
  return number
}

/** Expects the promise to be rejected by the database with a message matching `pattern`. */
export async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise
  } catch (error) {
    const message = (error as Error).message
    if (!pattern.test(message)) {
      throw new Error(`Expected error matching ${pattern}, got: ${message}`)
    }
    return
  }
  throw new Error(`Expected database error matching ${pattern}, but the statement succeeded`)
}
