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

// ---- Konto: Passwort vergessen, Zurücksetzen, E-Mail-Bestätigung (P2.10) ---------------------

/** One-time link token: 256 bit, base64url (43 characters). */
export const accountToken = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{43}$/,
    'Der Link ist ungültig. Bitte den vollständigen Link aus der E-Mail öffnen.',
  )

export const passwordResetRequest = z.object({ email })
export const accountTokenRequest = z.object({ token: accountToken })
export const passwordResetConfirm = z.object({ token: accountToken, password })
/** Administration: reset link for a person of the company (to hand over or by e-mail). */
export const adminPasswordResetRequest = z.object({ sendEmail: z.boolean().default(false) })

export interface PasswordResetRequested {
  /** Without SMTP no e-mail can be sent – the administration creates a link instead. */
  emailEnabled: boolean
}

export interface PasswordResetInfo {
  email: string
  displayName: string
  expiresAt: string
}

export interface AdminPasswordReset {
  resetUrl: string
  expiresAt: string
  emailQueued: boolean
}

export interface EmailVerificationRequested {
  emailEnabled: boolean
  /** Already confirmed: nothing was sent. */
  alreadyVerified: boolean
}

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
  user: {
    id: string
    email: string
    displayName: string
    totpEnabled: boolean
    webauthnCount: number
    /** The e-mail address was confirmed (link in a mail, invitation by mail or password reset). */
    emailVerified: boolean
  }
  tenant: { id: string; name: string }
  role: { key: string; name: string; access: Membership['access'] }
  permissions: string[]
  memberships: Membership[]
  /** Admins must enrol a second factor (DESIGN.md §5.2); until then only security settings are reachable. */
  twoFactorSetupRequired: boolean
}

export type MfaMethod = 'totp' | 'webauthn'

/**
 * `mfa_required`: password was correct; a short-lived HttpOnly cookie marks the pending login and
 * the client completes it with /auth/login/totp or /auth/login/webauthn/*.
 */
export type LoginResponse =
  | { status: 'ok'; me: Me }
  | { status: 'mfa_required'; methods: MfaMethod[] }

export const loginTotpRequest = z.object({ code: totpCode })

/** WebAuthn ceremony payloads are validated by the WebAuthn library; here only the envelope. */
export const webauthnResponse = z.object({ response: z.record(z.string(), z.unknown()) })
export const webauthnRegisterRequest = webauthnResponse.extend({
  name: z.string().trim().min(1, 'Bitte einen Namen vergeben, z. B. „YubiKey Büro“.').max(100),
})
export const renameCredentialRequest = z.object({ name: z.string().trim().min(1).max(100) })

export interface WebauthnCredentialSummary {
  id: string
  name: string
  deviceType: 'singleDevice' | 'multiDevice'
  backedUp: boolean
  createdAt: string
  lastUsedAt: string | null
}

export interface SecurityOverview {
  totpEnabled: boolean
  credentials: WebauthnCredentialSummary[]
  /** Admins need at least one second factor (TOTP or security key). */
  mfaRequired: boolean
}

export interface TotpSetupResponse {
  /** Base32 secret for manual entry. */
  secret: string
  /** otpauth:// URI for QR codes. */
  uri: string
}
