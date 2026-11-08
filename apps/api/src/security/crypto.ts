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
export class FieldCipher {
  private readonly key: Buffer

  constructor(appSecret: string) {
    this.key = Buffer.from(
      hkdfSync('sha256', appSecret, 'opc-field-encryption', 'aes-256-gcm/v1', 32),
    )
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext])
  }

  decrypt(payload: Buffer): string {
    if (payload.length < 29 || payload[0] !== 1) throw new Error('Unsupported ciphertext format')
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.subarray(1, 13))
    decipher.setAuthTag(payload.subarray(13, 29))
    return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]).toString('utf8')
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
