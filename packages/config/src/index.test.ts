import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, runsApi, runsWorker } from './index.js'

const base = { DATABASE_URL: 'postgres://u:p@db:5432/app' }

describe('loadConfig', () => {
  it('applies safe defaults for the compact profile', () => {
    const config = loadConfig(base)
    expect(config.APP_ROLE).toBe('all')
    expect(config.PROFILE).toBe('compact')
    expect(config.PORT).toBe(3000)
    expect(config.NODE_ENV).toBe('production')
    expect(config.MIGRATE_ON_START).toBe(true)
  })

  it('parses boolean flags', () => {
    expect(loadConfig({ ...base, MIGRATE_ON_START: 'false' }).MIGRATE_ON_START).toBe(false)
    expect(() => loadConfig({ ...base, MIGRATE_ON_START: 'yes' })).toThrow(/MIGRATE_ON_START/)
  })

  it('coerces numeric variables', () => {
    expect(loadConfig({ ...base, PORT: '8080' }).PORT).toBe(8080)
  })

  it('rejects a missing or non-postgres database url', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/)
  })

  it('rejects unknown roles', () => {
    expect(() => loadConfig({ ...base, APP_ROLE: 'cron' })).toThrow(/APP_ROLE/)
  })
})

describe('roles', () => {
  it('maps roles to processes', () => {
    expect([runsApi('all'), runsWorker('all')]).toEqual([true, true])
    expect([runsApi('api'), runsWorker('api')]).toEqual([true, false])
    expect([runsApi('worker'), runsWorker('worker')]).toEqual([false, true])
  })
})
