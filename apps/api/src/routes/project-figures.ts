import type { Tx } from '@easybau/db'
import {
  type BilledDocument,
  type ProjectCostType,
  projectCosts,
  projectFigures,
} from '@easybau/domain'
import {
  type DocumentDetail,
  type ProjectFigureColumns,
  type ProjectFiguresDto,
  projectFiguresListQuery,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requirePermission,
  requireVisibleProject,
  type Services,
} from '../context.js'
import { parse } from '../http.js'
import { projectContract } from './change-orders.js'
import { loadDocument } from './documents.js'

/**
 * Projektkennzahlen (P2.7, DESIGN.md §2): Soll-Stunden aus der Kalkulation, Auftragssumme
 * (Vertragssumme), abgerechnet, bezahlt, offene Forderungen und noch abzurechnen.
 */

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

/** Soll-Stunden of the contract documents; partially accepted change orders count accepted items only. */
async function plannedHours(
  tx: Tx,
  auth: AuthContext,
  projectId: string,
): Promise<{ hours: string[]; uncalculated: number; basis: ProjectFiguresDto['hoursBasis'] }> {
  const contract = await projectContract(tx, projectId)
  const hours: string[] = []
  let uncalculated = 0
  const add = (doc: DocumentDetail | null, onlyItems?: Set<string>) => {
    if (!doc) return
    if (!onlyItems) {
      hours.push(doc.totals.laborHours)
      uncalculated += doc.totals.uncalculatedCount
      return
    }
    for (const item of doc.items.filter((i) => onlyItems.has(i.id))) {
      if (item.calculation) hours.push(item.calculation.laborHours)
      else if (item.positionType === 'item' || item.positionType === 'lump_sum') uncalculated += 1
    }
  }
  if (contract.contract) {
    add(await loadDocument(tx, auth, contract.contract.id))
    for (const order of contract.changeOrders) {
      if (order.status === 'accepted') add(await loadDocument(tx, auth, order.id))
      if (order.status === 'partially_accepted') {
        const accepted = await tx<{ id: string }[]>`
          select i.id from document_item i join change_order_item_decision d on d.document_item_id = i.id
          where i.document_id = ${order.id} and d.accepted`
        add(await loadDocument(tx, auth, order.id), new Set(accepted.map((a) => a.id)))
      }
    }
    return {
      hours,
      uncalculated,
      basis: {
        kind: 'contract',
        label: contract.contract.number ?? 'Auftragsbestätigung (Entwurf)',
      },
    }
  }
  // Without Hauptauftrag: the latest quote (Angebot) not rejected – a forecast for planning.
  const [quote] = await tx<{ id: string; number: string | null }[]>`
    select id, number from document
    where project_id = ${projectId} and type in ('quote', 'cost_estimate')
      and status not in ('cancelled', 'rejected')
    order by created_at desc limit 1`
  if (!quote) return { hours, uncalculated, basis: null }
  add(await loadDocument(tx, auth, quote.id))
  return {
    hours,
    uncalculated,
    basis: { kind: 'quote', label: quote.number ?? 'Angebot (Entwurf)' },
  }
}

export async function loadProjectFigures(
  tx: Tx,
  auth: AuthContext,
  projectId: string,
): Promise<ProjectFiguresDto> {
  const contract = await projectContract(tx, projectId)
  const planned = await plannedHours(tx, auth, projectId)
  // Finalized invoices and credit notes; cancelled invoices and their Stornorechnungen cancel out.
  const ids = await tx<{ id: string }[]>`
    select id from document
    where project_id = ${projectId} and type in ('invoice', 'credit_note') and finalized_at is not null
      and status <> 'cancelled' and invoice_kind is distinct from 'cancellation'
    order by document_date, created_at`
  const documents: BilledDocument[] = []
  for (const { id } of ids) {
    const doc = await loadDocument(tx, auth, id)
    if (!doc) continue
    documents.push({
      type: doc.type === 'credit_note' ? 'credit_note' : 'invoice',
      netCents: BigInt(doc.totals.netCents),
      grossCents: BigInt(doc.totals.grossCents),
      openCents: BigInt(doc.receivable?.openCents ?? 0),
      paidCents: BigInt(doc.receivable?.paidCents ?? 0),
    })
  }
  const figures = projectFigures({
    contractNetCents: contract.contract ? BigInt(contract.totals.totalNetCents) : null,
    plannedHours: planned.hours,
    uncalculatedCount: planned.uncalculated,
    documents,
  })
  const n = (v: bigint | null) => (v === null ? null : Number(v))
  // Projektkosten: confirmed incoming invoices allocated to the project (cancelled ones not).
  let costs: ProjectFiguresDto['costs'] = null
  if (auth.permissions.has('incoming_invoice.read')) {
    const rows = await tx<
      { costType: ProjectCostType; net: string; creditNote: boolean; invoiceId: string }[]
    >`
      select a.cost_type as "costType", a.net_cents::text as net,
             i.document_kind = 'credit_note' as "creditNote", i.id as "invoiceId"
      from incoming_invoice_allocation a join incoming_invoice i on i.id = a.incoming_invoice_id
      where a.project_id = ${projectId} and i.status = 'confirmed'`
    const sums = projectCosts(
      rows.map((r) => ({
        costType: r.costType,
        netCents: BigInt(r.net),
        creditNote: r.creditNote,
      })),
      figures.billedNetCents,
    )
    costs = {
      totalCents: Number(sums.totalCents),
      byType: Object.fromEntries(
        Object.entries(sums.byType).map(([k, v]) => [k, Number(v)]),
      ) as NonNullable<ProjectFiguresDto['costs']>['byType'],
      contributionCents: Number(sums.contributionCents),
      invoiceCount: new Set(rows.map((r) => r.invoiceId)).size,
    }
  }
  return {
    plannedHours: figures.plannedHours,
    hoursBasis: planned.basis,
    uncalculatedCount: figures.uncalculatedCount,
    contractNetCents: n(figures.contractNetCents),
    billedNetCents: Number(figures.billedNetCents),
    billedGrossCents: Number(figures.billedGrossCents),
    paidCents: Number(figures.paidCents),
    openReceivableCents: Number(figures.openReceivableCents),
    unbilledNetCents: n(figures.unbilledNetCents),
    overbilledNetCents: Number(figures.overbilledNetCents),
    billedPercent: figures.billedPercent,
    invoiceCount: documents.length,
    costs,
  }
}

export function registerProjectFigureRoutes(app: FastifyInstance, services: Services) {
  // Spalten der Projektliste: the same figures as in the project overview, for the shown page.
  app.get(
    '/api/v1/projects/figures',
    async (request): Promise<Record<string, ProjectFigureColumns>> => {
      const auth = requirePermission(request, 'document.read')
      const { ids } = parse(projectFiguresListQuery, request.query)
      return inTenant(services, auth, async (tx) => {
        const visible = await tx<{ id: string }[]>`
          select p.id from project p where p.id in ${tx(ids)} and ${projectVisibility(tx, auth)}`
        const result: Record<string, ProjectFigureColumns> = {}
        for (const { id } of visible) {
          const f = await loadProjectFigures(tx, auth, id)
          result[id] = {
            contractNetCents: f.contractNetCents,
            billedNetCents: f.billedNetCents,
            billedPercent: f.billedPercent,
            openReceivableCents: f.openReceivableCents,
            unbilledNetCents: f.unbilledNetCents,
          }
        }
        return result
      })
    },
  )

  // Finance figures: only for people who may read documents (Monteure see no amounts).
  app.get('/api/v1/projects/:id/figures', async (request): Promise<ProjectFiguresDto> => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      return loadProjectFigures(tx, auth, id)
    })
  })
}
