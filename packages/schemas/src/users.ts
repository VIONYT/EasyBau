import { z } from 'zod'
import { password } from './auth.js'
import { email, optionalText, text } from './common.js'

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
}

export interface InvitationSummary {
  id: string
  email: string
  displayName: string | null
  role: Pick<RoleSummary, 'key' | 'name'>
  expiresAt: string
  createdAt: string
}

export const inviteRequest = z.object({
  email,
  displayName: optionalText(200),
  roleKey: z.string().min(1, 'Bitte eine Rolle wählen.').max(50),
})
export type InviteRequest = z.infer<typeof inviteRequest>

export interface InviteResponse {
  invitation: InvitationSummary
  /** Link to hand over to the person (shown once; only its hash is stored). */
  acceptUrl: string
}

export const updateMemberRequest = z.object({ roleKey: z.string().min(1).max(50) })

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
