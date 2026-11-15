import type { Tx } from '@opc/db'
import { Decimal } from '@opc/domain'
import { germanDate } from '@opc/exports'
import {
  applyReportsRequest,
  type BillableReport,
  type EquipmentValue,
  type QuantityRowsValue,
  type ReportSection,
  type StaffValue,
} from '@opc/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type AuthContext, inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { loadDocument, lockDraft, recalculate, sendDocument } from './documents.js'
import { totalHours } from './reports.js'

/**
 * Regie-/Einsatzberichte abrechnen (P2.5, VOB/B § 15): a signed report of a billable template
 * becomes a title with its positions in an invoice draft – staff hours per Lohngruppe at the
 * Stundenverrechnungssatz, Leistungen, Material and Geräte with their quantities (price to be
 * entered). Finalizing the invoice marks the report as billed; a Storno releases it again.
 */

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

interface ReportRow {
  id: string
  projectId: string
  status: BillableReport['status']
  reportDate: string
  serviceFrom: string | null
  serviceTo: string | null
  data: Record<string, unknown>
  sections: ReportSection[]
  templateKey: string
  templateName: string
  billable: boolean
  billedNumber: string | null
  billed: boolean
  /** Non-cancelled invoice (draft or finalized) that already contains the report. */
  usedIn: { id: string; number: string | null } | null
}

function reportRows(tx: Tx, where: ReturnType<Tx>) {
  return tx<ReportRow[]>`
    select r.id, r.project_id as "projectId", r.status, to_char(r.report_date, 'YYYY-MM-DD') as "reportDate",
           to_char(r.service_from, 'YYYY-MM-DD') as "serviceFrom", to_char(r.service_to, 'YYYY-MM-DD') as "serviceTo",
           r.data, coalesce(r.template_snapshot, t.sections) as sections, t.key as "templateKey",
           t.name as "templateName", t.billable,
           b.number as "billedNumber", b.id is not null as billed,
           (select json_build_object('id', d.id, 'number', d.number)
            from document_item i join document d on d.id = i.document_id
            where i.source_report_id = r.id and d.type = 'invoice' and d.status <> 'cancelled'
              and d.invoice_kind is distinct from 'cancellation'
            order by d.created_at limit 1) as "usedIn"
    from report r
    join report_template t on t.id = r.template_id
    left join document b on b.id = r.billed_in_invoice_id and b.status <> 'cancelled'
    where ${where}
    order by r.report_date, r.created_at`
}

function blockedReason(row: ReportRow, documentId: string): string | null {
  if (!row.billable) return 'Diese Berichtsart wird nicht abgerechnet.'
  if (row.status !== 'signed') return 'Der Bericht ist noch nicht unterschrieben.'
  if (row.billed) return `Bereits abgerechnet mit Rechnung ${row.billedNumber}.`
  if (row.usedIn && row.usedIn.id !== documentId) {
    return row.usedIn.number
      ? `Bereits in Rechnung ${row.usedIn.number} enthalten.`
      : 'Bereits in einem anderen Rechnungsentwurf enthalten.'
  }
  return null
}

const titleOf = (row: ReportRow) => {
  const period =
    row.serviceFrom && row.serviceTo && row.serviceFrom !== row.serviceTo
      ? ` (Leistungszeitraum ${germanDate(row.serviceFrom)} – ${germanDate(row.serviceTo)})`
      : ''
  return `${row.templateName} vom ${germanDate(row.reportDate)}${period}`
}

const valuesOf = <T>(row: ReportRow, type: string): T[] =>
  row.sections
    .filter((s) => s.type === type)
    .map((s) => row.data[s.id] as T | undefined)
    .filter((v): v is T => Boolean(v))

interface UnitInfo {
  id: string
  symbol: string
  unece: string
  decimals: number
}

interface NewItem {
  shortText: string
  longText: string | null
  quantity: string
  unit: UnitInfo
  unitPriceCents: number
  /** Stundenlohn: Kalkulation with one labor line, so the hours count as Lohnkosten (§ 35a). */
  labor?: { wageGroupId: string; costCents: string; markupPercent: string }
}

/** Positions of one report: staff hours per Lohngruppe, Leistungen, Material, Geräte. */
async function itemsOf(
  tx: Tx,
  row: ReportRow,
  units: { byId: Map<string, UnitInfo>; hour: UnitInfo; lumpSum: UnitInfo },
): Promise<NewItem[]> {
  const items: NewItem[] = []
  const staff = valuesOf<StaffValue>(row, 'staff').flatMap((v) => v.rows)
  if (staff.length) {
    const userIds = [...new Set(staff.map((s) => s.userId).filter((u): u is string => !!u))]
    const groups = await tx<
      {
        userId: string | null
        id: string
        name: string
        rate: string
        cost: string
        markup: string
      }[]
    >`
      select m.user_id as "userId", w.id, w.name, w.hourly_rate_cents::text as rate,
             w.cost_per_hour_cents::text as cost, trim_scale(w.markup_percent)::text as markup
      from membership m join wage_group w on w.id = m.wage_group_id
      where w.is_active and m.user_id = any(${userIds}::uuid[])
      union all
      (select null, w.id, w.name, w.hourly_rate_cents::text, w.cost_per_hour_cents::text,
              trim_scale(w.markup_percent)::text
       from wage_group w where w.is_active
       order by w.sort, w.name limit 1)`
    const fallback = groups.find((g) => g.userId === null) ?? null
    const byGroup = new Map<
      string,
      {
        name: string
        rate: number
        hours: Decimal
        people: string[]
        sort: number
        labor: NewItem['labor']
      }
    >()
    for (const person of staff) {
      const group = groups.find((g) => g.userId && g.userId === person.userId) ?? fallback
      const key = group?.id ?? ''
      const entry = byGroup.get(key) ?? {
        name: group?.name ?? '',
        rate: Number(group?.rate ?? 0),
        hours: new Decimal(0),
        people: [],
        sort: byGroup.size,
        labor: group
          ? { wageGroupId: group.id, costCents: group.cost, markupPercent: group.markup }
          : undefined,
      }
      entry.hours = entry.hours.plus(person.hours)
      entry.people.push(
        `${person.name}: ${String(person.hours).replace('.', ',')} Std.${person.activity ? ` – ${person.activity}` : ''}`,
      )
      byGroup.set(key, entry)
    }
    for (const group of byGroup.values()) {
      if (group.hours.isZero()) continue
      items.push({
        shortText: group.name ? `Stundenlohnarbeiten ${group.name}` : 'Stundenlohnarbeiten',
        longText: group.people.join('\n'),
        quantity: group.hours.toDecimalPlaces(units.hour.decimals).toString(),
        unit: units.hour,
        unitPriceCents: group.rate,
        ...(group.labor ? { labor: group.labor } : {}),
      })
    }
  }
  for (const type of ['services', 'materials'] as const) {
    for (const value of valuesOf<QuantityRowsValue>(row, type)) {
      for (const r of value.rows) {
        const unit = (r.unitId ? units.byId.get(r.unitId) : undefined) ?? units.lumpSum
        const quantity = new Decimal(r.quantity ?? '1').toDecimalPlaces(
          unit.decimals,
          Decimal.ROUND_HALF_UP,
        )
        if (quantity.isZero()) continue
        items.push({
          shortText: r.description,
          longText: type === 'materials' ? 'Material' : null,
          quantity: quantity.toString(),
          unit,
          unitPriceCents: 0,
        })
      }
    }
  }
  for (const value of valuesOf<EquipmentValue>(row, 'equipment')) {
    for (const r of value.rows) {
      const unit = r.hours ? units.hour : units.lumpSum
      const quantity = new Decimal(r.hours ?? '1').toDecimalPlaces(unit.decimals)
      if (quantity.isZero()) continue
      items.push({
        shortText: r.description,
        longText: 'Gerätestunden',
        quantity: quantity.toString(),
        unit,
        unitPriceCents: 0,
      })
    }
  }
  return items
}

async function unitsFor(tx: Tx) {
  const rows = await tx<(UnitInfo & { unece: string })[]>`
    select id, symbol, unece_code as unece, decimals from unit where is_active`
  const byId = new Map(rows.map((u) => [u.id, u]))
  const hour = rows.find((u) => u.unece === 'HUR')
  const lumpSum = rows.find((u) => u.symbol === 'psch') ?? rows.find((u) => u.unece === 'LS')
  if (!hour || !lumpSum) {
    throw new HttpError(409, 'Die Einheiten „Std“ und „psch“ fehlen in den Stammdaten.')
  }
  return { byId, hour, lumpSum }
}

async function requireInvoiceDraft(tx: Tx, auth: AuthContext, id: string) {
  const doc = await loadDocument(tx, auth, id)
  if (!doc) throw notFound('Das Dokument')
  if (doc.type !== 'invoice' || doc.invoiceKind === 'cancellation') {
    throw new HttpError(409, 'Berichte lassen sich nur in eine Rechnung übernehmen.')
  }
  return doc
}

/** At Festschreiben (same transaction): the reports behind the invoice are billed now. */
export async function markReportsBilled(tx: Tx, invoiceId: string): Promise<void> {
  await tx`
    update report set billed_in_invoice_id = ${invoiceId}
    where id in (select source_report_id from document_item
                 where document_id = ${invoiceId} and source_report_id is not null)
      and billed_in_invoice_id is distinct from ${invoiceId}`
}

/** Finalize check: a report must not be billed twice (two drafts finalized one after another). */
export async function reportBillingProblems(
  tx: Tx,
  invoiceId: string,
): Promise<{ field: string; message: string }[]> {
  const rows = await tx<{ title: string; number: string }[]>`
    select distinct t.name || ' vom ' || to_char(r.report_date, 'DD.MM.YYYY') as title, b.number
    from document_item i
    join report r on r.id = i.source_report_id
    join report_template t on t.id = r.template_id
    join document b on b.id = r.billed_in_invoice_id
    where i.document_id = ${invoiceId} and b.id <> ${invoiceId} and b.status <> 'cancelled'`
  return rows.map((r) => ({
    field: 'items',
    message: `Der ${r.title} ist bereits mit Rechnung ${r.number} abgerechnet. Bitte die Positionen entfernen.`,
  }))
}

export function registerReportBillingRoutes(app: FastifyInstance, services: Services) {
  app.get('/api/v1/documents/:id/reports', async (request): Promise<BillableReport[]> => {
    const auth = requirePermission(request, 'document.read')
    const { id } = parse(idParam, request.params)
    return inTenant(services, auth, async (tx) => {
      const doc = await requireInvoiceDraft(tx, auth, id)
      const rows = await reportRows(tx, tx`r.project_id = ${doc.project.id} and t.billable`)
      return rows.map((row) => ({
        id: row.id,
        template: { key: row.templateKey, name: row.templateName },
        reportDate: row.reportDate,
        serviceFrom: row.serviceFrom,
        serviceTo: row.serviceTo,
        status: row.status,
        totalHours: totalHours(row.sections, row.data),
        inThisDocument: row.usedIn?.id === id,
        blocked: row.usedIn?.id === id ? null : blockedReason(row, id),
      }))
    })
  })

  app.post('/api/v1/documents/:id/apply-reports', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(idParam, request.params)
    const { reportIds } = parse(applyReportsRequest, request.body)
    const doc = await inTenant(services, auth, async (tx) => {
      const { projectId } = await lockDraft(tx, auth, id)
      await requireInvoiceDraft(tx, auth, id)
      const ids = [...new Set(reportIds)]
      // Lock the reports so two drafts cannot take the same report at the same time.
      await tx`select id from report where id = any(${ids}::uuid[]) for update`
      const rows = await reportRows(tx, tx`r.id = any(${ids}::uuid[])`)
      const errors: Record<string, string> = {}
      for (const [index, reportId] of ids.entries()) {
        const row = rows.find((r) => r.id === reportId)
        const problem = !row
          ? 'Diesen Bericht gibt es nicht.'
          : row.projectId !== projectId
            ? 'Der Bericht gehört zu einem anderen Projekt.'
            : row.usedIn?.id === id
              ? 'Der Bericht ist bereits in dieser Rechnung.'
              : blockedReason(row, id)
        if (problem) errors[`reportIds.${index}`] = problem
      }
      if (Object.keys(errors).length) {
        throw new HttpError(409, Object.values(errors)[0] as string, errors)
      }
      const units = await unitsFor(tx)
      const [rate] = await tx<{ percent: string }[]>`
        select trim_scale(percent)::text as percent from tax_rate where is_default limit 1`
      const taxRate = rate?.percent ?? '19'
      for (const row of rows) {
        const items = await itemsOf(tx, row, units)
        if (!items.length) {
          throw new HttpError(
            409,
            `Der ${titleOf(row)} enthält keine Stunden, Leistungen, Materialien oder Geräte.`,
          )
        }
        const [title] = await tx<{ id: string }[]>`
          insert into document_item (tenant_id, document_id, parent_id, sort, position_type, short_text,
                                     source_report_id)
          values (${auth.tenantId}, ${id}, null,
                  (select (coalesce(max(sort), 0) + 10)::int from document_item
                   where document_id = ${id} and parent_id is null),
                  'title', ${titleOf(row)}, ${row.id})
          returning id`
        for (const [index, item] of items.entries()) {
          const [created] = await tx<{ id: string }[]>`
            insert into document_item ${tx({
              tenant_id: auth.tenantId,
              document_id: id,
              parent_id: (title as { id: string }).id,
              sort: (index + 1) * 10,
              position_type: 'item',
              short_text: item.shortText,
              long_text: item.longText,
              quantity: item.quantity,
              unit_id: item.unit.id,
              unit_symbol: item.unit.symbol,
              unit_unece_code: item.unit.unece,
              unit_price_cents: item.unitPriceCents,
              tax_rate_percent: taxRate,
              calc_mode: 'unit_price',
              source_report_id: row.id,
            })}
            returning id`
          if (item.labor) {
            // 1 Std Lohn per Std: the price stays the Stundenverrechnungssatz of the Lohngruppe.
            await tx`
              insert into item_calc_component ${tx({
                tenant_id: auth.tenantId,
                document_id: id,
                document_item_id: (created as { id: string }).id,
                sort: 10,
                cost_kind: 'labor',
                quantity: '1',
                unit_id: units.hour.id,
                description: item.shortText,
                unit_cost_cents: item.labor.costCents,
                markup_percent: item.labor.markupPercent,
                wage_group_id: item.labor.wageGroupId,
              })}`
          }
        }
      }
      await recalculate(tx, id)
      return loadDocument(tx, auth, id)
    })
    return sendDocument(reply, doc)
  })
}
