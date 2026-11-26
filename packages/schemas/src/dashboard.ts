import { z } from 'zod'
import type { DocumentStatus, DocumentType } from './documents.js'
import type { ProjectSummary } from './projects.js'

/** Amount and number of invoices in one receivable state. */
export interface DashboardSum {
  count: number
  cents: number
}

/** Übersicht (GET /dashboard, P2.8); parts the user may not see are null. */
export interface DashboardDto {
  today: string
  /** Offene Forderungen brutto (Recht document.read). */
  receivables: {
    open: DashboardSum
    overdue: DashboardSum
    dunned: DashboardSum
    total: DashboardSum
    /** Rechnungen, deren nächste Mahnstufe heute ausgestellt werden kann. */
    dunningDueCount: number
  } | null
  /** Eingangsrechnungen „Zu prüfen“ (Recht incoming_invoice.read). */
  incomingReviewCount: number | null
  /** Zuletzt bearbeitete Projekte (sichtbar, nicht archiviert). */
  recentProjects: ProjectSummary[]
  /** Offene Angebote, Kostenvoranschläge und Nachträge: fertiggestellt oder versendet, nicht entschieden. */
  openOffers:
    | {
        id: string
        type: Extract<DocumentType, 'quote' | 'cost_estimate' | 'change_order'>
        number: string | null
        subject: string | null
        status: DocumentStatus
        documentDate: string
        validUntil: string | null
        netCents: number
        project: { id: string; number: string | null; name: string }
      }[]
    | null
  /** Heute auf der Baustelle: eigene Projekte, deren Zeitraum heute läuft. */
  todaysSites: {
    id: string
    number: string | null
    name: string
    site: string | null
    /** Projektzeitraum: Zeitbalken „Tag x von y“ (start is always set for today's sites). */
    startDate: string | null
    endDate: string | null
  }[]
}

/** Übersicht ohne Beträge (GET /dashboard/site): offline auf dem Gerät gespeichert. */
export type DashboardSiteDto = Pick<DashboardDto, 'today' | 'recentProjects' | 'todaysSites'>

/** Globale Suche (GET /search). */
export const searchQuery = z.object({
  q: z.string().trim().min(2, 'Bitte mindestens 2 Zeichen eingeben.').max(200),
})

export type SearchKind =
  | 'project'
  | 'contact'
  | 'document'
  | 'catalog'
  | 'incoming'
  | 'sheet'
  | 'report'
  | 'file'

export interface SearchHit {
  kind: SearchKind
  id: string
  label: string
  detail: string | null
  /** Project of a document, to open it. */
  projectId: string | null
}

export interface SearchResult {
  q: string
  groups: { kind: SearchKind; hits: SearchHit[] }[]
}

export type NotificationKind = 'invoice_overdue' | 'change_order_decided' | 'report_signed'

export interface NotificationItem {
  id: string
  kind: NotificationKind
  title: string
  body: string | null
  /** Path in the web app to open. */
  route: string
  createdAt: string
  read: boolean
}

/** GET /notifications: the latest 50 and the number of unread ones. */
export interface NotificationList {
  unreadCount: number
  items: NotificationItem[]
}
