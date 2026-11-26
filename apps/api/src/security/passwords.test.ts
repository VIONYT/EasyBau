import { hash } from '@node-rs/argon2'
import { describe, expect, it } from 'vitest'
import { PASSWORD_OPTIONS, PasswordHasher, parseStoredHash, pepperKeyId } from './passwords.js'

const PEPPER = `${'a'.repeat(32)}-pepper-eins`
const NEW_PEPPER = `${'b'.repeat(32)}-pepper-zwei`
const PASSWORD = 'ein-sehr-langes-passwort'

describe('password hashing (argon2id, RFC 9106)', () => {
  const plain = new PasswordHasher()

  it('hashes with argon2id, 64 MiB, 3 passes, 4 lanes and a random salt per hash', async () => {
    const a = await plain.hash(PASSWORD)
    const b = await plain.hash(PASSWORD)
    expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)
    // Same password, different salt → different hash.
    const salt = (h: string) => h.split('$')[4]
    expect(salt(a)).not.toBe(salt(b))
    expect(Buffer.from(salt(a) as string, 'base64')).toHaveLength(16)
    expect(a).not.toBe(b)
    expect(await plain.verify(a, PASSWORD)).toBe(true)
    expect(await plain.verify(a, 'falsches-passwort')).toBe(false)
    expect(await plain.verify('kein-hash', 'x')).toBe(false)
    expect(plain.needsRehash(a)).toBe(false)
    expect(plain.keyId).toBeNull()
  })

  it('detects hashes that need an upgrade', async () => {
    const old = await hash('passwort', { memoryCost: 19_456, timeCost: 2, parallelism: 1 })
    expect(plain.needsRehash(old)).toBe(true)
    expect(plain.needsRehash('$argon2i$v=19$m=65536,t=3,p=4$abc$def')).toBe(true)
    expect(plain.needsRehash('$2b$12$bcrypt')).toBe(true)
    expect(PASSWORD_OPTIONS.memoryCost).toBeGreaterThanOrEqual(65_536)
  })

  it('limits parallel hashing without losing requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => plain.hash(`passwort-${i}-langgenug`)),
    )
    expect(new Set(results).size).toBe(6)
  })

  it('times unknown e-mails like real verifications', async () => {
    await expect(plain.verifyDummy('x')).resolves.toBeUndefined()
  })
})

describe('password pepper (argon2id secret key)', () => {
  const peppered = new PasswordHasher({ pepper: PEPPER })
  const plain = new PasswordHasher()

  it('marks peppered hashes with a key id that does not reveal the pepper', async () => {
    const stored = await peppered.hash(PASSWORD)
    const id = pepperKeyId(PEPPER)
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    expect(stored.startsWith(`pepper:${id}:$argon2id$v=19$m=65536,t=3,p=4$`)).toBe(true)
    expect(stored).not.toContain(PEPPER)
    expect(parseStoredHash(stored)).toMatchObject({ keyId: id })
    expect(parseStoredHash('$argon2id$x')).toEqual({ keyId: null, phc: '$argon2id$x' })
    expect(await peppered.verify(stored, PASSWORD)).toBe(true)
    expect(await peppered.verify(stored, 'falsch')).toBe(false)
    expect(peppered.needsRehash(stored)).toBe(false)
    expect(await peppered.hash(PASSWORD)).not.toBe(stored)
  })

  it('cannot be checked without the pepper – not even by removing the marker', async () => {
    const stored = await peppered.hash(PASSWORD)
    expect(await plain.verify(stored, PASSWORD)).toBe(false)
    expect(await plain.verify(parseStoredHash(stored).phc, PASSWORD)).toBe(false)
    expect(await new PasswordHasher({ pepper: NEW_PEPPER }).verify(stored, PASSWORD)).toBe(false)
    // A forged marker with the right id but a hash made without pepper does not pass either.
    const unpeppered = await plain.hash(PASSWORD)
    expect(await peppered.verify(`pepper:${pepperKeyId(PEPPER)}:${unpeppered}`, PASSWORD)).toBe(
      false,
    )
  })

  it('switching on, changing and switching off rehash at the next login', async () => {
    const before = await plain.hash(PASSWORD)
    // On: old hashes still verify, then get rehashed with the pepper.
    expect(await peppered.verify(before, PASSWORD)).toBe(true)
    expect(peppered.needsRehash(before)).toBe(true)

    // Changed: the old pepper stays as PREVIOUS until everybody has logged in once.
    const withOld = await peppered.hash(PASSWORD)
    const rotated = new PasswordHasher({ pepper: NEW_PEPPER, previousPepper: PEPPER })
    expect(await rotated.verify(withOld, PASSWORD)).toBe(true)
    expect(rotated.needsRehash(withOld)).toBe(true)
    const withNew = await rotated.hash(PASSWORD)
    expect(parseStoredHash(withNew).keyId).toBe(pepperKeyId(NEW_PEPPER))
    expect(rotated.needsRehash(withNew)).toBe(false)
    expect(rotated.knownKeyIds).toEqual([null, pepperKeyId(NEW_PEPPER), pepperKeyId(PEPPER)])

    // Off (old pepper as PREVIOUS): peppered hashes verify and are rehashed without pepper.
    const off = new PasswordHasher({ previousPepper: NEW_PEPPER })
    expect(await off.verify(withNew, PASSWORD)).toBe(true)
    expect(off.needsRehash(withNew)).toBe(true)
    expect(off.needsRehash(await off.hash(PASSWORD))).toBe(false)
  })
})
