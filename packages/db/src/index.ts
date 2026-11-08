import type { Config } from '@opc/config'
import postgres from 'postgres'

export type Sql = postgres.Sql

/** Creates the shared connection pool. Pool size is small on purpose (compact profile, ADR 0002). */
export function createSql(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>): Sql {
  return postgres(config.DATABASE_URL, {
    max: config.DATABASE_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 5,
    onnotice: () => {},
  })
}

/** Readiness probe: true if the database answers within the timeout. */
export async function pingDatabase(sql: Sql, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('database ping timeout')), timeoutMs)
    })
    await Promise.race([sql`select 1`, timeout])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
