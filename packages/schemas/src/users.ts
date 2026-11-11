import { z } from 'zod'
import { password } from './auth.js'
import { email, isoDate, optionalText, text } from './common.js'

export interface RoleSummary {
  id: string
  key: string
  name: string
  access: 'office' | 'site' | 'readonly'
  isSystem: boolean
  permissions: string[]
}

export interface MemberSummary {
  userId: string
  displayName: string
  email: string
  role: Pick<RoleSummary, 'key' | 'name' | 'access'>
  totpEnabled: boolean
  webauthnCount: number
  lastLoginAt: string | null
  isSelf: boolean
  /** Access ends after this day (required for the auditor role); null = unlimited. */
  validUntil: string | null
  /** The access has ended (the person can no longer sign in to this company). */
  expired: boolean
}

export interface InvitationSummary {
  id: string
  email: string
  displayName: string | null
  role: Pick<RoleSummary, 'key' | 'name'>
  expiresAt: string
  createdAt: string
  /** Access of the invited person ends after this day. */
  accessUntil: string | null
}

export const inviteRequest = z.object({
  email,
  displayName: optionalText(200),
  roleKey: z.string().min(1, 'Bitte eine Rolle wählen.').max(50),
  /** Also send the link by e-mail (only when SMTP is configured). */
  sendEmail: z.boolean().optional(),
  /** Last day of access; required for the auditor role (Prüfer), at most one year ahead. */
  accessUntil: isoDate.optional(),
})
export type InviteRequest = z.infer<typeof inviteRequest>

export interface InviteResponse {
  invitation: InvitationSummary
  /** Link to hand over to the person (shown once; only its hash is stored). */
  acceptUrl: string
  /** The link was put into the e-mail outbox. */
  emailQueued: boolean
}

export const updateMemberRequest = z
  .object({
    roleKey: z.string().min(1).max(50).optional(),
    /** Last day of access (null = unlimited, not allowed for auditors). */
    validUntil: isoDate.nullable().optional(),
  })
  .refine((v) => v.roleKey !== undefined || v.validUntil !== undefined, 'Keine Änderung angegeben.')

/** Public view of an invitation for the acceptance page. */
export interface InvitationInfo {
  tenantName: string
  email: string
  displayName: string | null
  roleName: string
  /** The e-mail already has a login: accept with its password instead of creating a new one. */
  existingAccount: boolean
}

export const acceptInvitationRequest = z.object({
  displayName: text(200).optional(),
  password,
})
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequest>
