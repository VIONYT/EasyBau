import { z } from 'zod'
import { countryCode, id, isoDate, listQuery, optionalText, text } from './common.js'

export const projectSite = z.object({
  street: optionalText(200),
  streetExtra: optionalText(200),
  postalCode: optionalText(20),
  city: optionalText(100),
  countryCode: countryCode.default('DE'),
})

const projectFields = {
  name: text(300),
  description: optionalText(5000),
  statusId: id.nullish(),
  customerId: id.nullish(),
  site: projectSite.optional(),
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
  memberIds: z.array(id).max(200).optional(),
}

function checkDates(
  value: { startDate?: string | null | undefined; endDate?: string | null | undefined },
  ctx: z.RefinementCtx,
) {
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'Das Ende darf nicht vor dem Beginn liegen.',
    })
  }
}

export const createProjectRequest = z
  .object({
    ...projectFields,
    /** Manual project number; if omitted, P-… is drawn from the number sequence. */
    number: optionalText(50),
  })
  .superRefine(checkDates)
export type CreateProjectRequest = z.infer<typeof createProjectRequest>

export const updateProjectRequest = z
  .object({ ...projectFields, number: optionalText(50) })
  .partial()
  .superRefine(checkDates)
export type UpdateProjectRequest = z.infer<typeof updateProjectRequest>

export const projectListQuery = listQuery.extend({
  statusId: id.optional(),
  memberId: id.optional(),
  customerId: id.optional(),
  archived: z.enum(['true', 'false']).default('false'),
  /** Zeitraum: projects whose period (start–end) overlaps from–to; projects without dates are left out. */
  from: isoDate.optional(),
  to: isoDate.optional(),
})

export interface ProjectStatus {
  id: string
  key: string
  label: string
  color: string | null
  sort: number
  isClosed: boolean
}

export interface ProjectSummary {
  id: string
  number: string | null
  name: string
  status: Pick<ProjectStatus, 'id' | 'label' | 'color'> | null
  customer: { id: string; displayName: string } | null
  siteCity: string | null
  startDate: string | null
  endDate: string | null
  members: { id: string; displayName: string }[]
  archived: boolean
  updatedAt: string
}

export interface ProjectDetail extends ProjectSummary {
  description: string | null
  site: z.infer<typeof projectSite>
  createdAt: string
}

/** Projektkennzahlen (GET /projects/:id/figures, P2.7); amounts in cents. */
export interface ProjectFiguresDto {
  /** Soll-Stunden from the Kalkulation of the contract (or, without contract, of the latest quote). */
  plannedHours: string
  /** Where the Soll-Stunden come from; null when there is no document to compute them from. */
  hoursBasis: { kind: 'contract' | 'quote'; label: string } | null
  /** Counted positions without Kalkulation (their hours are unknown). */
  uncalculatedCount: number
  /** Auftragssumme = Vertragssumme netto (Hauptauftrag + beauftragte Nachträge). */
  contractNetCents: number | null
  billedNetCents: number
  billedGrossCents: number
  paidCents: number
  openReceivableCents: number
  unbilledNetCents: number | null
  overbilledNetCents: number
  billedPercent: string | null
  invoiceCount: number
}

/** Person of the company for project teams and filters (GET /team: names only). */
export interface TeamMember {
  id: string
  displayName: string
}
