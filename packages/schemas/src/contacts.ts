import { z } from 'zod'
import { color, countryCode, email, id, listQuery, optionalText } from './common.js'

export const contactKind = z.enum(['person', 'organization'])
export const taxMode = z.enum([
  'standard',
  'reverse_charge_13b',
  'small_business',
  'intra_eu',
  'export',
])
export const einvoiceFormat = z.enum(['zugferd', 'xrechnung_ubl', 'xrechnung_cii'])

export const contactChannel = z.object({
  kind: z.enum(['email', 'phone', 'mobile', 'fax']),
  value: z.string().trim().min(1, 'Darf nicht leer sein.').max(254),
  label: z.enum(['work', 'private', 'other']).default('work'),
  isPrimary: z.boolean().default(false),
})

export const contactAddress = z.object({
  kind: z.enum(['main', 'billing', 'delivery', 'other']),
  recipientBlock: optionalText(500),
  street: optionalText(200),
  streetExtra: optionalText(200),
  postalCode: optionalText(20),
  city: optionalText(100),
  countryCode: countryCode.default('DE'),
})

const contactFields = {
  organizationName: optionalText(200),
  salutation: optionalText(50),
  title: optionalText(50),
  firstName: optionalText(100),
  lastName: optionalText(100),
  website: optionalText(300),
  color: color.nullish(),
  description: optionalText(5000),
  paymentTermId: id.nullish(),
  taxMode: taxMode.optional(),
  vatId: optionalText(30),
  buyerReference: optionalText(100),
  einvoiceEmail: email.nullish(),
  einvoiceFormat: einvoiceFormat.nullish(),
  /** Replaces all channels / addresses when given. */
  channels: z.array(contactChannel).max(30).optional(),
  addresses: z.array(contactAddress).max(10).optional(),
}

function requireName(
  value: {
    kind?: string | undefined
    organizationName?: string | null | undefined
    firstName?: string | null | undefined
    lastName?: string | null | undefined
  },
  ctx: z.RefinementCtx,
) {
  if (value.kind === 'organization' && !value.organizationName) {
    ctx.addIssue({
      code: 'custom',
      path: ['organizationName'],
      message: 'Bitte den Namen der Organisation angeben.',
    })
  }
  if (value.kind === 'person' && !value.firstName && !value.lastName) {
    ctx.addIssue({
      code: 'custom',
      path: ['lastName'],
      message: 'Bitte Vor- oder Nachnamen angeben.',
    })
  }
}

export const createContactRequest = z
  .object({
    kind: contactKind,
    /** Draws a Kundennummer (K-…) from the number sequence. */
    assignCustomerNumber: z.boolean().default(true),
    ...contactFields,
  })
  .superRefine(requireName)
export type CreateContactRequest = z.infer<typeof createContactRequest>

export const updateContactRequest = z.object(contactFields).partial()
export type UpdateContactRequest = z.infer<typeof updateContactRequest>

export const contactListQuery = listQuery.extend({
  kind: contactKind.optional(),
  color: color.optional(),
  archived: z.enum(['true', 'false']).default('false'),
})

export const linkContactRequest = z.object({
  organizationId: id,
  role: optionalText(100),
})

export interface ContactSummary {
  id: string
  kind: 'person' | 'organization'
  number: string | null
  displayName: string
  color: string | null
  primaryEmail: string | null
  primaryPhone: string | null
  city: string | null
  archived: boolean
  updatedAt: string
}

export interface ContactDetail
  extends Omit<ContactSummary, 'primaryEmail' | 'primaryPhone' | 'city'> {
  organizationName: string | null
  salutation: string | null
  title: string | null
  firstName: string | null
  lastName: string | null
  website: string | null
  description: string | null
  paymentTermId: string | null
  taxMode: z.infer<typeof taxMode>
  vatId: string | null
  buyerReference: string | null
  einvoiceEmail: string | null
  einvoiceFormat: z.infer<typeof einvoiceFormat> | null
  channels: (z.infer<typeof contactChannel> & { id: string })[]
  addresses: (z.infer<typeof contactAddress> & { id: string })[]
  links: {
    contactId: string
    displayName: string
    kind: 'person' | 'organization'
    role: string | null
  }[]
  projects: { id: string; number: string | null; name: string; updatedAt: string }[]
  createdAt: string
}
