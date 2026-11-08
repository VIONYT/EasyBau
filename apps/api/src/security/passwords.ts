import { hash, verify } from '@node-rs/argon2'

/**
 * argon2id with OWASP-recommended parameters (19 MiB memory, 2 iterations).
 * Moderate memory keeps the compact profile (2 GB server) safe under login bursts.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}

let dummyHash: Promise<string> | undefined

/** Burns the same time as a real verification, so unknown e-mails cannot be detected by timing. */
export async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing')
  await verifyPassword(await dummyHash, password)
}
