import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FieldCipher } from './crypto.js'

const SECRET = 's'.repeat(40)

/** Format v1 as written before the field binding (no additional data). */
function legacy(plaintext: string): Buffer {
  const key = Buffer.from(hkdfSync('sha256', SECRET, 'opc-field-encryption', 'aes-256-gcm/v1', 32))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext])
}

describe('FieldCipher', () => {
  const cipher = new FieldCipher(SECRET)

  it('binds a value to its field: it cannot be decrypted as another field', () => {
    const totp = cipher.encrypt('JBSWY3DPEHPK3PXP', 'app_user.totp')
    expect(cipher.decrypt(totp, 'app_user.totp')).toBe('JBSWY3DPEHPK3PXP')
    expect(() => cipher.decrypt(totp, 'tenant.iban')).toThrow()
    expect(cipher.isLegacy(totp)).toBe(false)
  })

  it('still reads values written before the binding', () => {
    const old = legacy('DE02120300000000202051')
    expect(cipher.isLegacy(old)).toBe(true)
    expect(cipher.decrypt(old, 'tenant.iban')).toBe('DE02120300000000202051')
    expect(() => cipher.decrypt(Buffer.from([9, ...randomBytes(40)]), 'tenant.iban')).toThrow(
      /Unsupported/,
    )
  })
})
