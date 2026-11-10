import { describe, expect, it } from 'vitest'
import { createSql, pingDatabase } from './index.js'

const url = process.env.DATABASE_URL

describe.skipIf(!url)('database (integration)', () => {
  it('answers the readiness ping', async () => {
    const sql = createSql({ DATABASE_URL: url as string, DATABASE_POOL_MAX: 2 })
    try {
      expect(await pingDatabase(sql)).toBe(true)
      const [row] = await sql<{ server_version: string }[]>`show server_version`
      expect(Number.parseInt(row?.server_version ?? '0', 10)).toBeGreaterThanOrEqual(16)
    } finally {
      await sql.end()
    }
  })

  it('reports false for an unreachable database', async () => {
    const sql = createSql({ DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none', DATABASE_POOL_MAX: 1 })
    try {
      expect(await pingDatabase(sql, 1000)).toBe(false)
    } finally {
      await sql.end({ timeout: 0 })
    }
  })
})
