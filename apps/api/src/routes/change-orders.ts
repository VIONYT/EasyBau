import type { Tx } from '@easybau/db'
import { type ChangeOrderStatus, contractTotals, Decimal, quantityDeviation } from '@easybau/domain'
import { germanDate } from '@easybau/exports'
import {
  changeOrderEvidenceRequest,
  type ProjectContract,
  type SheetVariance,
  varianceChangeOrderRequest,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  inTenant,
  projectVisibility,
  requirePermission,
  requireVisibleProject,
  type Services,
} from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { createDocument, loadDocument, recalculate, sendDocument } from './documents.js'
import { checkEvidence } from './evidence.js'

/**
 * Nachträge ausbauen (P2.6): Vertragssumme = Hauptauftrag + beauftragte Nachträge, Nachweise
 * (Berichte, Aufmaßblätter, Dateien) je Nachtrag and Nachträge aus Mehrmengen eines Leistungsaufmaßes.
 */

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

export async function projectContract(tx: Tx, projectId: string): Promise<ProjectContract> {
  const [contract] = await tx<(NonNullable<ProjectContract['contract']> & { netRaw: string })[]>`
    select id, number, status, to_char(document_date, 'YYYY-MM-DD') as "documentDate",
           net_total_cents::text as "netRaw"
    from document
    where project_id = ${projectId} and type = 'order_confirmation' and status <> 'cancelled'
    order by created_at desc limit 1`
  const orders = await tx<
    (Omit<ProjectContract['changeOrders'][number], 'netCents' | 'acceptedNetCents'> & {
      netRaw: string
      acceptedRaw: string
    })[]
  >`
    select d.id, d.number, m.number as "changeOrderNumber", m.basis, m.status, d.subject, m.reason,
           d.net_total_cents::text as "netRaw",
           coalesce((select sum(i.total_cents) from document_item i
                     join change_order_item_decision dec on dec.document_item_id = i.id
                     where i.document_id = d.id and dec.accepted), 0)::text as "acceptedRaw",
           jsonb_array_length(m.evidence)::int as "evidenceCount",
           to_char(m.decided_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as "decidedAt"
    from change_order_meta m join document d on d.id = m.document_id
    where d.project_id = ${projectId} and d.status <> 'cancelled'
    order by m.number, d.created_at`
  const amounts = orders.map((o) => ({
    status: o.status as ChangeOrderStatus,
    netCents: BigInt(o.netRaw),
    acceptedNetCents: BigInt(o.acceptedRaw),
  }))
  const totals = contractTotals(contract ? BigInt(contract.netRaw) : null, amounts)
  return {
    contract: contract
      ? {
          id: contract.id,
          number: contract.number,
          status: contract.status,
          documentDate: contract.documentDate,
          netCents: Number(contract.netRaw),
        }
      : null,
    changeOrders: orders.map(({ netRaw, acceptedRaw: _, ...o }, index) => ({
      ...o,
      netCents: Number(netRaw),
      acceptedNetCents: Number(
        amounts[index]?.status === 'accepted'
          ? netRaw
          : amounts[index]?.status === 'partially_accepted'
            ? amounts[index].acceptedNetCents
            : 0,
      ),
    })),
    totals: Object.fromEntries(
      Object.entries(totals).map(([key, value]) => [key, Number(value)]),
    ) as ProjectContract['totals'],
  }
}

interface VarianceRow {
  id: string
  oz: string | null
  shortText: string | null
  quantity: string
  unitId: string | null
  unitSymbol: string | null
  unitUnece: string | null
  decimals: number | null
  unitPriceCents: string
  taxRate: string | null
  discountPercent: string | null
  documentLabel: string
  measured: string
  claimed: string
}

/**
 * Mehrmengen of the contract positions measured on a sheet: everything measured in the
 * Leistungsaufmaß (all sheets) beyond the ordered quantity and beyond Mehrmengen already claimed
 * in other change orders (not rejected).
 */
async function variancesOf(tx: Tx, sheetId: string): Promise<(VarianceRow & { extra: string })[]> {
  return (await measuredItemsOf(tx, sheetId)).filter((row) => new Decimal(row.extra).gt(0))
}

/** All contract positions measured on the sheet with their Mehrmenge (≤ 0: none). */
async function measuredItemsOf(
  tx: Tx,
  sheetId: string,
): Promise<(VarianceRow & { extra: string })[]> {
  const rows = await tx<VarianceRow[]>`
    select i.id, i.oz, i.short_text as "shortText", trim_scale(i.quantity)::text as quantity,
           i.unit_id as "unitId", i.unit_symbol as "unitSymbol", i.unit_unece_code as "unitUnece",
           u.decimals, i.unit_price_cents::text as "unitPriceCents",
           trim_scale(i.tax_rate_percent)::text as "taxRate", trim_scale(i.discount_percent)::text as "discountPercent",
           coalesce(d.number, case when d.type = 'order_confirmation' then 'Auftragsbestätigung' else 'Nachtrag' end)
             as "documentLabel",
           coalesce((select trim_scale(sum(l.result_qty)) from measurement_line l
                     join measurement_sheet s on s.id = l.sheet_id
                     where l.document_item_id = i.id and s.kind = 'performance'), 0)::text as measured,
           coalesce((select trim_scale(sum(v.quantity)) from document_item v
                     join document vd on vd.id = v.document_id
                     left join change_order_meta vm on vm.document_id = vd.id
                     where v.variance_of_item_id = i.id and vd.status <> 'cancelled'
                       and coalesce(vm.status, 'draft') <> 'rejected'), 0)::text as claimed
    from document_item i
    join document d on d.id = i.document_id
    left join change_order_meta co on co.document_id = d.id
    left join unit u on u.id = i.unit_id
    where i.id in (select document_item_id from measurement_line
                   where sheet_id = ${sheetId} and document_item_id is not null)
      and i.position_type = 'item' and i.quantity is not null and d.status <> 'cancelled'
      and (d.type = 'order_confirmation'
           or (d.type = 'change_order' and co.status in ('accepted', 'partially_accepted')))
    order by d.created_at, string_to_array(coalesce(i.oz, '0'), '.')::int[], i.sort`
  return rows.map((row) => {
    const extra = new Decimal(row.measured)
      .minus(row.quantity)
      .minus(row.claimed)
      .toDecimalPlaces(row.decimals ?? 2, Decimal.ROUND_DOWN)
    return { ...row, extra: Decimal.max(extra, 0).toString() }
  })
}

const qty = (value: string, unit: string | null) =>
  `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 }).format(Number(value))}${unit ? ` ${unit}` : ''}`

export function registerChangeOrderRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/projects/:id/contract', async (request): Promise<ProjectContract> => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, async (tx) => {
      await requireVisibleProject(tx, auth, id)
      return projectContract(tx, id)
    })
  })

  // Nachweise can be added while the change order is negotiated (also after it was offered).
  app.put('/api/v1/documents/:id/evidence', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(idParam, request.params)
    const { evidence } = parse(changeOrderEvidenceRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      const [row] = await tx<{ projectId: string; status: string }[]>`
        select d.project_id as "projectId", d.status
        from change_order_meta m join document d on d.id = m.document_id
        join project p on p.id = d.project_id
        where m.document_id = ${id} and ${projectVisibility(tx, auth)}
        for update of m`
      if (!row) throw notFound('Der Nachtrag')
      if (row.status === 'cancelled') throw new HttpError(409, 'Der Nachtrag ist storniert.')
      const refs = await checkEvidence(tx, row.projectId, evidence)
      await tx`update change_order_meta set evidence = ${tx.json(refs as never)} where document_id = ${id}`
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
  })

  app.get('/api/v1/measurement-sheets/:id/variances', async (request): Promise<SheetVariance[]> => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, async (tx) => {
      const [sheet] = await tx<{ id: string }[]>`
        select s.id from measurement_sheet s join project p on p.id = s.project_id
        where s.id = ${id} and ${projectVisibility(tx, auth)}`
      if (!sheet) throw notFound('Das Aufmaßblatt')
      // Mehrmengen, plus positions more than 10 % below the order (VOB/B § 2 Abs. 3 Nr. 3).
      return (await measuredItemsOf(tx, id)).flatMap((v) => {
        const { percent, rule } = quantityDeviation(v.quantity, v.measured)
        if (new Decimal(v.extra).lte(0) && rule !== 'under_90') return []
        return [
          {
            itemId: v.id,
            oz: v.oz,
            shortText: v.shortText,
            unit: v.unitSymbol,
            orderedQuantity: v.quantity,
            measuredQuantity: v.measured,
            claimedQuantity: v.claimed,
            extraQuantity: v.extra,
            measuredPercent: percent,
            deviation: rule,
          },
        ]
      })
    })
  })

  app.post('/api/v1/measurement-sheets/:id/change-order', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(idParam, request.params)
    const { itemIds } = parse(varianceChangeOrderRequest, request.body ?? {})
    const doc = await inTenant(services, auth, async (tx) => {
      const [sheet] = await tx<
        { projectId: string; kind: string; title: string; measuredOn: string; archived: boolean }[]
      >`
        select s.project_id as "projectId", s.kind, s.title, to_char(s.measured_on, 'YYYY-MM-DD') as "measuredOn",
               p.archived_at is not null as archived
        from measurement_sheet s join project p on p.id = s.project_id
        where s.id = ${id} and ${projectVisibility(tx, auth)}`
      if (!sheet) throw notFound('Das Aufmaßblatt')
      if (sheet.archived) {
        throw new HttpError(409, 'Das Projekt ist archiviert. Bitte zuerst wiederherstellen.')
      }
      if (sheet.kind !== 'performance') {
        throw new HttpError(409, 'Mehrmengen ergeben sich nur aus einem Leistungsaufmaß.')
      }
      // Serialise per project: two clicks must not claim the same Mehrmenge twice.
      await tx`select 1 from project where id = ${sheet.projectId} for update`
      const variances = (await variancesOf(tx, id)).filter(
        (v) => !itemIds || itemIds.includes(v.id),
      )
      if (!variances.length) {
        throw new HttpError(
          409,
          'Auf diesem Aufmaßblatt gibt es keine Mehrmengen gegenüber dem Auftrag (oder sie sind schon in einem Nachtrag).',
        )
      }
      const documentId = await createDocument(tx, auth, sheet.projectId, {
        type: 'change_order',
        basis: 'quantity_variance',
        reason: `Mehrmengen laut Aufmaßblatt „${sheet.title}“ vom ${germanDate(sheet.measuredOn)}`,
        evidence: [{ kind: 'measurement_sheet', id }],
      })
      for (const [index, v] of variances.entries()) {
        await tx`
          insert into document_item ${tx({
            tenant_id: auth.tenantId,
            document_id: documentId,
            parent_id: null,
            sort: (index + 1) * 10,
            position_type: 'item',
            short_text: v.shortText,
            long_text: `Mehrmenge zu Pos. ${v.oz ?? '–'} (${v.documentLabel}): beauftragt ${qty(v.quantity, v.unitSymbol)}, laut Aufmaß ${qty(v.measured, v.unitSymbol)}${Number(v.claimed) ? `, bereits in Nachträgen ${qty(v.claimed, v.unitSymbol)}` : ''}.`,
            quantity: v.extra,
            unit_id: v.unitId,
            unit_symbol: v.unitSymbol,
            unit_unece_code: v.unitUnece,
            unit_price_cents: v.unitPriceCents,
            discount_percent: v.discountPercent,
            tax_rate_percent: v.taxRate,
            calc_mode: 'unit_price',
            variance_of_item_id: v.id,
          })}`
      }
      await recalculate(tx, documentId)
      return loadDocument(tx, auth, documentId)
    })
    reply.header('location', `/api/v1/documents/${doc?.id}`)
    return sendDocument(reply, doc, 201)
  })
}
