import { z } from 'zod'
import { email } from './common.js'

export interface EmailSettings {
  /** SMTP is configured on the server (SMTP_HOST, SMTP_FROM in .env). */
  enabled: boolean
  from: string | null
}

export const testEmailRequest = z.object({ to: email.optional() })

export interface EmailMessageSummary {
  id: string
  kind: 'invitation' | 'test' | 'document'
  toAddress: string
  subject: string
  status: 'queued' | 'sending' | 'sent' | 'failed'
  attempts: number
  lastError: string | null
  createdAt: string
  sentAt: string | null
}
