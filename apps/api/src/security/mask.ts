/** Field names of secrets, also nested (e.g. tenant.settings.incomingMail.passwordEnc). */
// Not *_hash: content and chain hashes (document.content_hash, audit_event.prev_hash) are proof.
const SECRET_KEY = /(_enc|Enc|secret|Secret|password|Password)$/

export const MASK = '••••'

/** Deep copy with every secret value replaced by a mask (audit view, exports). */
export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item)) as T
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) && item !== null && item !== undefined ? MASK : maskSecrets(item),
    ]),
  ) as T
}
