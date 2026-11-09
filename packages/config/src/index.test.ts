import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, resolveFileSecrets, runsApi, runsWorker } from './index.js'

const base = {
  DATABASE_URL: 'postgres://u:p@db:5432/app',
  APP_SECRET: 'x'.repeat(32),
}

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
    expect(() => loadConfig({ APP_SECRET: base.APP_SECRET })).toThrow(ConfigError)
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

describe('secrets', () => {
  it('requires a long APP_SECRET', () => {
    expect(() => loadConfig({ ...base, APP_SECRET: 'short' })).toThrow(/APP_SECRET/)
  })

  it('reads NAME_FILE secrets, explicit values win', () => {
    const read = (path: string) => `secret-from-${path}\n`
    expect(resolveFileSecrets({ APP_SECRET_FILE: '/run/a' }, read).APP_SECRET).toBe(
      'secret-from-/run/a',
    )
    expect(
      resolveFileSecrets({ APP_SECRET: 'x', APP_SECRET_FILE: '/run/a' }, read).APP_SECRET,
    ).toBe('x')
    expect(resolveFileSecrets({ EMPTY_FILE: '' }, read).EMPTY).toBeUndefined()
    expect(resolveFileSecrets({ SETUP_TOKEN: '' }, read).SETUP_TOKEN).toBeUndefined()
  })

  it('reports unreadable secret files', () => {
    expect(() =>
      loadConfig({ ...base, APP_SECRET: undefined, APP_SECRET_FILE: '/nonexistent/secret' }),
    ).toThrow(/APP_SECRET_FILE/)
  })

  it('applies security defaults', () => {
    const config = loadConfig(base)
    expect([config.COOKIE_SECURE, config.SESSION_TTL_DAYS, config.SESSION_IDLE_HOURS]).toEqual([
      true,
      30,
      168,
    ])
    expect(config.SETUP_TOKEN).toBeUndefined()
    expect(config.REQUIRE_ADMIN_MFA).toBe(true)
    expect(config.PUBLIC_URL).toBeUndefined()
    expect(loadConfig({ ...base, PUBLIC_URL: 'https://erp.example.de/' }).PUBLIC_URL).toBe(
      'https://erp.example.de',
    )
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'ftp://x' })).toThrow(/PUBLIC_URL/)
  })

  it('keeps e-mail off unless SMTP is configured', async () => {
    const { smtpEnabled } = await import('./index.js')
    const config = loadConfig(base)
    expect(smtpEnabled(config)).toBe(false)
    expect([config.SMTP_PORT, config.SMTP_SECURE]).toEqual([587, false])
    const smtp = loadConfig({
      ...base,
      SMTP_HOST: 'mail.example.de',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_FROM: 'Muster Bau <buero@example.de>',
      SMTP_PASSWORD_FILE: '',
    })
    expect(smtpEnabled(smtp)).toBe(true)
    expect([smtp.SMTP_PORT, smtp.SMTP_SECURE]).toEqual([465, true])
    expect(() => loadConfig({ ...base, SMTP_HOST: 'mail.example.de' })).toThrow(/SMTP_FROM/)
  })

  it('has storage defaults and limits uploads', () => {
    const config = loadConfig(base)
    expect([config.STORAGE_DIR, config.UPLOAD_MAX_MB]).toEqual(['/data/files', 50])
    expect(loadConfig({ ...base, UPLOAD_MAX_MB: '200' }).UPLOAD_MAX_MB).toBe(200)
    expect(() => loadConfig({ ...base, UPLOAD_MAX_MB: '0' })).toThrow(/UPLOAD_MAX_MB/)
  })
})
