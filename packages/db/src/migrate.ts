import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type postgres from 'postgres'

/** Directory with the versioned SQL migrations (`NNNN_name.sql`), shipped next to `dist/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/
const LOCK_KEY = 4_711_000_001n

export interface MigrateOptions {
  dir?: string
  /** Bookkeeping table; only tests override it. */
  table?: string
  log?: (message: string) => void
}

export interface MigrationResult {
  applied: string[]
  alreadyApplied: number
}

interface MigrationFile {
  version: number
  name: string
  checksum: string
  sql: string
}

async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const files: MigrationFile[] = []
  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry)
    if (!match) throw new Error(`Invalid migration file name: ${entry} (expected NNNN_name.sql)`)
    const sql = await readFile(`${dir}/${entry}`, 'utf8')
    files.push({
      version: Number(match[1]),
      name: match[2] as string,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    })
  }
  const versions = new Set(files.map((f) => f.version))
  if (versions.size !== files.length) throw new Error('Duplicate migration version numbers')
  return files
}

/**
 * Applies pending migrations, forward-only (ADR 0003).
 * - Serialised with an advisory lock, so several containers can start at the same time.
 * - Each migration runs in its own transaction.
 * - Checksums of applied migrations are verified: editing a released migration is an error.
 * Must run with the admin connection (`createSql(config, { mode: 'admin' })`).
 */
export async function migrate(
  sql: postgres.Sql,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const { dir = MIGRATIONS_DIR, table = 'schema_migration', log = () => {} } = options
  if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid migration table name')
  const files = await readMigrations(dir)

  const reserved = await sql.reserve()
  try {
    await reserved`select pg_advisory_lock(${LOCK_KEY.toString()}::bigint)`
    await reserved.unsafe(`
      create table if not exists ${table} (
        version    integer primary key,
        name       text not null,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`)
    const rows = await reserved.unsafe<{ version: number; name: string; checksum: string }[]>(
      `select version, name, checksum from ${table} order by version`,
    )
    const applied = new Map(rows.map((r) => [r.version, r]))

    for (const [version, row] of applied) {
      const file = files.find((f) => f.version === version)
      if (!file) throw new Error(`Migration ${version}_${row.name} is applied but missing on disk`)
      if (file.checksum !== row.checksum) {
        throw new Error(
          `Migration ${version}_${row.name} was modified after it was applied. ` +
            'Released migrations are immutable; add a new migration instead.',
        )
      }
    }

    const result: MigrationResult = { applied: [], alreadyApplied: applied.size }
    for (const file of files) {
      if (applied.has(file.version)) continue
      const label = `${String(file.version).padStart(4, '0')}_${file.name}`
      log(`applying migration ${label}`)
      await reserved.unsafe('begin')
      try {
        await reserved.unsafe(file.sql)
        await reserved.unsafe(
          `insert into ${table} (version, name, checksum) values ($1, $2, $3)`,
          [file.version, file.name, file.checksum],
        )
        await reserved.unsafe('commit')
      } catch (error) {
        await reserved.unsafe('rollback')
        throw new Error(`Migration ${label} failed: ${(error as Error).message}`, { cause: error })
      }
      result.applied.push(label)
    }
    return result
  } finally {
    await reserved`select pg_advisory_unlock(${LOCK_KEY.toString()}::bigint)`.catch(() => {})
    reserved.release()
  }
}
