import { hash } from '@node-rs/argon2'
import { describe, expect, it } from 'vitest'
import { hashPassword, needsRehash, PASSWORD_OPTIONS, verifyPassword } from './passwords.js'

describe('password hashing (argon2id, RFC 9106)', () => {
  it('hashes with argon2id, 64 MiB, 3 passes, 4 lanes and a random salt', async () => {
    const a = await hashPassword('ein-sehr-langes-passwort')
    const b = await hashPassword('ein-sehr-langes-passwort')
    expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)
    expect(a).not.toBe(b)
    expect(await verifyPassword(a, 'ein-sehr-langes-passwort')).toBe(true)
    expect(await verifyPassword(a, 'falsches-passwort')).toBe(false)
    expect(await verifyPassword('kein-hash', 'x')).toBe(false)
    expect(needsRehash(a)).toBe(false)
  })

  it('detects hashes that need an upgrade', async () => {
    const old = await hash('passwort', { memoryCost: 19_456, timeCost: 2, parallelism: 1 })
    expect(needsRehash(old)).toBe(true)
    expect(needsRehash('$argon2i$v=19$m=65536,t=3,p=4$abc$def')).toBe(true)
    expect(needsRehash('$2b$12$bcrypt')).toBe(true)
    expect(PASSWORD_OPTIONS.memoryCost).toBeGreaterThanOrEqual(65_536)
  })

  it('limits parallel hashing without losing requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => hashPassword(`passwort-${i}-langgenug`)),
    )
    expect(new Set(results).size).toBe(6)
  })
})
