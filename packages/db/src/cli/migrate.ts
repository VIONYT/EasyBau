import { loadConfig } from '@easybau/config'
import { createSql } from '../index.js'
import { migrate } from '../migrate.js'

// `pnpm db:migrate` – applies pending migrations with the admin connection.
const config = loadConfig()
const sql = createSql(config, { mode: 'admin' })
try {
  const result = await migrate(sql, { log: (m) => console.log(m) })
  console.log(
    result.applied.length
      ? `applied ${result.applied.length} migration(s)`
      : `database is up to date (${result.alreadyApplied} migrations)`,
  )
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
