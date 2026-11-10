import { copyFile, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSql, MIGRATIONS_DIR, migrate, type Sql, withTenant } from './index.js'
import { testDatabaseUrl } from './test-support.js'

/**
 * Migration 0008 (project filing) on a database that already has a company with a project:
 * the upgrade creates default folders; folder rules and tenant isolation hold.
 */
describe.skipIf(!testDatabaseUrl)('project filing (integration)', () => {
  let root: Sql
  let admin: Sql
  let app: Sql
  const name = `opc_filing_test_${Date.now().toString(36)}`
  const ids = { tenant: '', user: '', project: '', otherTenant: '', otherProject: '' }

  const asTenant = <T>(tenantId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, { tenantId, userId: ids.user }, fn)

  async function createCompany(tenantName: string) {
    const [row] = await admin<{ id: string }[]>`select uuid_v7() as id`
    const tenantId = row?.id as string
    let projectId = ''
    await asTenant(tenantId, async (tx) => {
      await tx`insert into tenant (id, name) values (${tenantId}, ${tenantName})`
      await tx`select seed_tenant_defaults()`
      const [p] = await tx<{ id: string }[]>`
        insert into project (tenant_id, name) values (${tenantId}, 'Altbau') returning id`
      projectId = p?.id as string
    })
    return { tenantId, projectId }
  }

  beforeAll(async () => {
    root = createSql(
      { DATABASE_URL: testDatabaseUrl as string, DATABASE_POOL_MAX: 1 },
      { mode: 'admin' },
    )
    await root.unsafe(`create database ${name}`)
    const url = new URL(testDatabaseUrl as string)
    url.pathname = `/${name}`
    admin = createSql({ DATABASE_URL: url.toString(), DATABASE_POOL_MAX: 2 }, { mode: 'admin' })
    app = createSql({ DATABASE_URL: url.toString(), DATABASE_POOL_MAX: 3 })

    // Schema as of 0007, with data …
    const before = await mkdtemp(join(tmpdir(), 'opc-before-0008-'))
    for (const file of await readdir(MIGRATIONS_DIR)) {
      if (file.endsWith('.sql') && file < '0008')
        await copyFile(join(MIGRATIONS_DIR, file), join(before, file))
    }
    await migrate(admin, { dir: before })
    const [user] = await admin<{ id: string }[]>`
      insert into app_user (email, display_name) values ('filing@example.test', 'Ablage') returning id`
    ids.user = user?.id as string
    const a = await createCompany('Firma A')
    const b = await createCompany('Firma B')
    Object.assign(ids, {
      tenant: a.tenantId,
      project: a.projectId,
      otherTenant: b.tenantId,
      otherProject: b.projectId,
    })
    // … then the upgrade.
    await migrate(admin)
  })

  afterAll(async () => {
    await app?.end({ timeout: 5 })
    await admin?.end({ timeout: 5 })
    await root.unsafe(`drop database if exists ${name} with (force)`)
    await root.end()
  })

  it('creates the default folder structure for existing companies and projects', async () => {
    const folders = await asTenant(
      ids.tenant,
      (tx) =>
        tx<
          { name: string }[]
        >`select name from project_folder where project_id = ${ids.project} order by sort`,
    )
    expect(folders.map((f) => f.name)).toEqual([
      'Pläne',
      'Fotos',
      'Verträge & Angebote',
      'Schriftverkehr',
      'Genehmigungen & Nachweise',
      'Sonstiges',
    ])
    // Idempotent seeding.
    await asTenant(ids.tenant, (tx) => tx`select seed_filing_defaults()`)
    const [count] = await asTenant(
      ids.tenant,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from filing_template`,
    )
    expect(count?.n).toBe(6)
  })

  it('isolates folders and templates between companies (RLS)', async () => {
    const seen = await asTenant(
      ids.otherTenant,
      (tx) => tx<{ project_id: string }[]>`select project_id from project_folder`,
    )
    expect(seen.length).toBe(6)
    expect(seen.every((f) => f.project_id === ids.otherProject)).toBe(true)
    await expect(
      asTenant(
        ids.otherTenant,
        (tx) => tx`
        insert into project_folder (tenant_id, project_id, name) values (${ids.tenant}, ${ids.project}, 'X')`,
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('keeps files in folders of their own project and rejects duplicate folder names', async () => {
    await asTenant(ids.tenant, async (tx) => {
      const [folder] = await tx<{ id: string }[]>`
        select id from project_folder where project_id = ${ids.project} and name = 'Fotos'`
      const [other] = await tx<{ id: string }[]>`
        insert into project (tenant_id, name) values (${ids.tenant}, 'Neubau') returning id`
      const file = {
        tenant_id: ids.tenant,
        filename: 'a.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 3,
        sha256: Buffer.alloc(32, 1),
      }
      await tx`insert into file ${tx({ ...file, project_id: ids.project, folder_id: folder?.id as string, storage_key: 'k1' })}`
      await expect(
        tx.savepoint(
          (sp) =>
            sp`insert into file ${sp({ ...file, project_id: other?.id as string, folder_id: folder?.id as string, storage_key: 'k2' })}`,
        ),
      ).rejects.toThrow(/does not belong to project/)
      await expect(
        tx.savepoint(
          (sp) => sp`
          insert into project_folder (tenant_id, project_id, name) values (${ids.tenant}, ${ids.project}, 'fotos')`,
        ),
      ).rejects.toThrow(/project_folder_name_uq/)
      await expect(
        tx.savepoint((sp) => sp`delete from project_folder where id = ${folder?.id as string}`),
      ).rejects.toThrow(/foreign key/)
      const audit = await tx<{ entity: string }[]>`
        select entity from audit_event where entity = 'file'`
      expect(audit.length).toBe(1)
    })
  })
})
