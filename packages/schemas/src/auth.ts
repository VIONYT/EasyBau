import { z } from 'zod'
import { countryCode, email, id, optionalText, text } from './common.js'

/** Password policy: length beats complexity rules (NIST SP 800-63B). */
export const password = z
  .string()
  .min(12, 'Das Passwort muss mindestens 12 Zeichen lang sein.')
  .max(256, 'Das Passwort darf höchstens 256 Zeichen lang sein.')

export const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Bitte den 6-stelligen Code aus der Authenticator-App eingeben.')

export const loginRequest = z.object({
  email,
  password: z.string().min(1, 'Bitte Passwort eingeben.').max(256),
  totp: totpCode.optional(),
  tenantId: id.optional(),
})
export type LoginRequest = z.infer<typeof loginRequest>

export const switchTenantRequest = z.object({ tenantId: id })

export const totpEnableRequest = z.object({ code: totpCode })
export const totpDisableRequest = z.object({ password: z.string().min(1).max(256), code: totpCode })

export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: password,
})

/** Ersteinrichtung: first company and its first administrator. */
export const setupRequest = z.object({
  setupToken: z
    .string()
    .trim()
    .min(1, 'Bitte den Einrichtungscode aus dem Server-Log eingeben.')
    .max(200),
  company: z.object({
    name: text(200),
    legalForm: optionalText(50),
    trade: optionalText(100),
    street: optionalText(200),
    postalCode: optionalText(20),
    city: optionalText(100),
    countryCode: countryCode.default('DE'),
    federalState: optionalText(50),
    email: email.optional(),
    phone: optionalText(50),
  }),
  admin: z.object({
    displayName: text(200),
    email,
    password,
  }),
})
export type SetupRequest = z.infer<typeof setupRequest>

export interface SetupStatus {
  setupRequired: boolean
}

export interface Membership {
  tenantId: string
  tenantName: string
  roleKey: string
  roleName: string
  access: 'office' | 'site' | 'readonly'
}

export interface Me {
  user: { id: string; email: string; displayName: string; totpEnabled: boolean }
  tenant: { id: string; name: string }
  role: { key: string; name: string; access: Membership['access'] }
  permissions: string[]
  memberships: Membership[]
  /** Admins must enrol a second factor (DESIGN.md §5.2); the UI forces the setup. */
  twoFactorSetupRequired: boolean
}

export type LoginResponse = { status: 'ok'; me: Me } | { status: 'totp_required' }

export interface TotpSetupResponse {
  /** Base32 secret for manual entry. */
  secret: string
  /** otpauth:// URI for QR codes. */
  uri: string
}
