import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/** Random URL-safe token (default 256 bit), e.g. for session cookies. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Constant-time comparison of two strings (compares their hashes, so lengths may differ). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

/**
 * Field encryption (AES-256-GCM) for secrets stored in the database: TOTP secrets, IBAN.
 * Key derived from APP_SECRET with HKDF. Format: 0x01 | iv(12) | tag(16) | ciphertext.
 */
/**
 * Where an encrypted value belongs. Version 2 binds the ciphertext to it (AES-GCM additional
 * data), so someone who can write the database cannot move e.g. the encrypted TOTP secret into
 * the IBAN column and have the app decrypt and show it (security audit run-1).
 */
export type CipherField =
  | 'tenant.iban'
  | 'app_user.totp'
  | 'incoming_mail.password'
  | 'incoming_mail.client_secret'
  | 'incoming_mail.google_key'

export class FieldCipher {
  private readonly key: Buffer

  constructor(appSecret: string) {
    this.key = Buffer.from(
      hkdfSync('sha256', appSecret, 'opc-field-encryption', 'aes-256-gcm/v1', 32),
    )
  }

  /** Format v2: [2][IV 12][tag 16][ciphertext], additional data = field name. */
  encrypt(plaintext: string, field: CipherField): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(field, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from([2]), iv, cipher.getAuthTag(), ciphertext])
  }

  /** Reads v2 for this field and the older v1 (no field binding; see `isLegacy`). */
  decrypt(payload: Buffer, field: CipherField): string {
    const version = payload[0]
    if (payload.length < 29 || (version !== 1 && version !== 2)) {
      throw new Error('Unsupported ciphertext format')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.subarray(1, 13))
    if (version === 2) decipher.setAAD(Buffer.from(field, 'utf8'))
    decipher.setAuthTag(payload.subarray(13, 29))
    return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]).toString('utf8')
  }

  /** Written before the field binding (v1): re-encrypted at start (`reencryptLegacyFields`). */
  isLegacy(payload: Buffer): boolean {
    return payload[0] === 1
  }
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238): HMAC-SHA1, 6 digits, 30 s steps, ±1 step tolerance
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(data: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new Error('Invalid base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const TOTP_STEP_SECONDS = 30

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)
}

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = (digest[19] as number) & 15
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return code.toString().padStart(6, '0')
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * Verifies a TOTP code. Returns the matched time step (for replay protection: callers must
 * reject steps ≤ the last accepted one) or null.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastStep: number | null = null,
): number | null {
  const secret = base32Decode(secretBase32)
  const current = totpStep(nowMs)
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue
    if (safeEqual(hotp(secret, step), code)) return step
  }
  return null
}

export function totpUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
