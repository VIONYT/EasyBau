import type { Sql } from '@easybau/db'
import { type CipherField, FieldCipher } from './crypto.js'

const MAILBOX_FIELDS: [string, CipherField][] = [
  ['passwordEnc', 'incoming_mail.password'],
  ['clientSecretEnc', 'incoming_mail.client_secret'],
  ['googleKeyEnc', 'incoming_mail.google_key'],
]

/**
 * Re-encrypts values written before the field binding (format v1) as v2, once at start with the
 * administrator connection (all companies). Idempotent; returns the number of values changed.
 */
export async function reencryptLegacyFields(admin: Sql, appSecret: string): Promise<number> {
  const cipher = new FieldCipher(appSecret)
  let changed = 0
  const again = (value: Buffer, field: CipherField) =>
    cipher.encrypt(cipher.decrypt(value, field), field)
  await admin.begin(async (tx) => {
    const tenants = await tx<
      { id: string; iban: Buffer | null; settings: Record<string, unknown> }[]
    >`
      select id, iban_enc as iban, settings from tenant for update`
    for (const t of tenants) {
      if (t.iban && cipher.isLegacy(t.iban)) {
        await tx`update tenant set iban_enc = ${again(t.iban, 'tenant.iban')} where id = ${t.id}`
        changed += 1
      }
      const mailbox = (t.settings?.incomingMail ?? null) as Record<string, unknown> | null
      if (!mailbox) continue
      let mailboxChanged = false
      for (const [key, field] of MAILBOX_FIELDS) {
        const value = mailbox[key]
        if (typeof value !== 'string') continue
        const raw = Buffer.from(value, 'base64')
        if (!cipher.isLegacy(raw)) continue
        mailbox[key] = again(raw, field).toString('base64')
        mailboxChanged = true
        changed += 1
      }
      if (mailboxChanged) {
        await tx`update tenant set settings = jsonb_set(settings, '{incomingMail}', ${tx.json(mailbox as never)})
                 where id = ${t.id}`
      }
    }
    const users = await tx<{ id: string; secret: Buffer | null; pending: Buffer | null }[]>`
      select id, totp_secret_enc as secret, totp_pending_secret_enc as pending from app_user
      where totp_secret_enc is not null or totp_pending_secret_enc is not null for update`
    for (const u of users) {
      const secret = u.secret && cipher.isLegacy(u.secret) ? again(u.secret, 'app_user.totp') : null
      const pending =
        u.pending && cipher.isLegacy(u.pending) ? again(u.pending, 'app_user.totp') : null
      if (!secret && !pending) continue
      await tx`update app_user set totp_secret_enc = coalesce(${secret}, totp_secret_enc),
                                   totp_pending_secret_enc = coalesce(${pending}, totp_pending_secret_enc)
               where id = ${u.id}`
      changed += (secret ? 1 : 0) + (pending ? 1 : 0)
    }
  })
  return changed
}
