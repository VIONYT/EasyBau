import type { Tx } from '@easybau/db'
import {
  type DunningLevel,
  nextDunningDue,
  type ReceivableState,
  receivableState,
} from '@easybau/domain'
import { csvLine, germanAmount, germanDate } from '@easybau/exports'
import {
  type AdjustmentKind,
  type InvoiceList,
  type InvoiceListItem,
  type InvoiceListQuery,
  invoiceListQuery,
  type Receivable,
  recordAdjustmentRequest,
  recordPaymentRequest,
  releaseRetentionRequest,
  reverseEntryRequest,
  updateAdjustmentRequest,
} from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  type AuthContext,
  inTenant,
  projectVisibility,
  requirePermission,
  type Services,
} from '../context.js'
import { decodeCursor, encodeCursor, HttpError, notFound, parse } from '../http.js'
import { loadDocument } from './documents.js'
import { isBilled, loadReceivable, todayIn, todayOf } from './receivable-state.js'

export { loadReceivable, todayIn, todayOf }

const idParam = z.object({ id: z.uuid('Ungültige ID.') })
/** Locks the invoice and loads it with its receivable; only finalized, not cancelled invoices. */
async function lockedReceivable(tx: Tx, auth: AuthContext, id: string, forNewEntry = true) {
  // Lock first, then read: the open amount and retention used for the limit checks below must
  // include every entry committed by a concurrent request (security audit run-1).
  await tx`select id from document where id = ${id} for update`
  const doc = await loadDocument(tx, auth, id)
  if (!doc) throw notFound('Die Rechnung')
  if (!isBilled(doc) || !doc.finalizedAt || !doc.receivable) {
    throw new HttpError(
      409,
      'Zahlungen gibt es nur zu festgeschriebenen Rechnungen und Gutschriften.',
    )
  }
  if (forNewEntry && doc.invoiceKind === 'cancellation') {
    throw new HttpError(409, 'Auf eine Stornorechnung werden keine Zahlungen gebucht.')
  }
  if (forNewEntry && doc.status === 'cancelled') {
    throw new HttpError(
      409,
      `Die Rechnung ${doc.number} ist storniert. Zahlungen dazu bitte als Gegenbuchung oder Erstattung außerhalb erfassen.`,
    )
  }
  return { doc, receivable: doc.receivable }
}

const invalid = (errors: Record<string, string>) =>
  new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)

async function reloadReceivable(tx: Tx, auth: AuthContext, id: string): Promise<Receivable> {
  const doc = await loadDocument(tx, auth, id)
  return doc?.receivable as Receivable
}

// ---- Rechnungsliste ------------------------------------------------------------------------------

interface ListRow {
  id: string
  type: InvoiceListItem['type']
  invoiceKind: InvoiceListItem['invoiceKind']
  progressNo: number | null
  number: string | null
  subject: string | null
  documentDate: string
  dueDate: string | null
  status: string
  recipient: string | null
  projectId: string
  projectNumber: string | null
  projectName: string
  net: string
  gross: string
  paid: string
  adjustments: { kind: AdjustmentKind; amount: number }[]
  plannedRetention: boolean
  dunned: boolean
  einvoice: boolean
  notices: { level: DunningLevel; dueDate: string }[]
}

/**
 * Index of the first invoice after the cursor (date, number, id) in the list order. Works also
 * when the invoice of the cursor left the filter meanwhile (e.g. paid while filtering "overdue").
 */
export function startAfter(
  items: readonly Pick<InvoiceListItem, 'documentDate' | 'number' | 'id'>[],
  [date, number, id]: readonly [string, string | null, string],
): number {
  const index = items.findIndex((i) =>
    i.documentDate !== date
      ? i.documentDate < date
      : i.number !== number
        ? i.number !== null && (number === null || i.number < number)
        : i.id < id,
  )
  return index === -1 ? items.length : index
}

export async function listInvoices(
  tx: Tx,
  auth: AuthContext,
  query: InvoiceListQuery,
  today: string,
): Promise<{ items: InvoiceListItem[]; sums: InvoiceList['sums'] }> {
  const q = query.q ? `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null
  const rows = await tx<ListRow[]>`
    select d.id, d.type, d.invoice_kind as "invoiceKind", d.progress_no as "progressNo", d.number,
           d.subject, to_char(d.document_date, 'YYYY-MM-DD') as "documentDate",
           to_char(d.due_date, 'YYYY-MM-DD') as "dueDate", d.status,
           coalesce(d.recipient_snapshot ->> 'name', c.display_name) as recipient,
           p.id as "projectId", p.number as "projectNumber", p.name as "projectName",
           d.net_total_cents::text as net, d.gross_total_cents::text as gross,
           coalesce((select sum(amount_cents) from payment where invoice_id = d.id), 0)::text as paid,
           coalesce((select json_agg(json_build_object('kind', kind, 'amount', amount_cents))
                     from receivable_adjustment where invoice_id = d.id), '[]'::json) as adjustments,
           coalesce(d.retention_percent, 0) > 0 as "plannedRetention",
           exists (select 1 from dunning_notice n where n.invoice_id = d.id and n.sent_at is not null) as dunned,
           exists (select 1 from document_artifact a where a.document_id = d.id
                   and a.kind in ('zugferd_xml', 'xrechnung_xml')) as einvoice,
           coalesce((select json_agg(json_build_object('level', n.level,
                                                       'dueDate', to_char(n.due_date, 'YYYY-MM-DD'))
                                     order by n.notice_date, n.created_at)
                     from dunning_notice n where n.invoice_id = d.id), '[]'::json) as notices
    from document d
    join project p on p.id = d.project_id
    left join contact c on c.id = d.contact_id
    where d.type in ('invoice', 'credit_note') and ${projectVisibility(tx, auth)}
      ${query.from ? tx`and d.document_date >= ${query.from}::date` : tx``}
      ${query.to ? tx`and d.document_date <= ${query.to}::date` : tx``}
      ${query.projectId ? tx`and d.project_id = ${query.projectId}` : tx``}
      ${
        q
          ? tx`and (d.number ilike ${q} or d.subject ilike ${q} or p.name ilike ${q}
                  or coalesce(d.recipient_snapshot ->> 'name', c.display_name) ilike ${q})`
          : tx``
      }
    -- "C" collation: byte order, the same as the string comparison in startAfter()
    order by d.document_date desc, d.number collate "C" desc nulls first, d.id desc`
  const items: InvoiceListItem[] = []
  const sums = { count: 0, netCents: 0, grossCents: 0, paidCents: 0, openCents: 0, overdueCents: 0 }
  for (const row of rows) {
    const draft = row.status === 'draft'
    const adjustments = row.adjustments.map((a) => ({
      kind: a.kind,
      amountCents: BigInt(a.amount),
    }))
    const state: ReceivableState | null = draft
      ? null
      : receivableState({
          grossCents: BigInt(row.gross),
          paidCents: BigInt(row.paid),
          adjustments,
          dueDate: row.dueDate,
          today,
          cancelled: row.status === 'cancelled' || row.invoiceKind === 'cancellation',
          dunned: row.dunned,
        })
    const status = state?.status ?? 'draft'
    if (query.status && query.status !== status) continue
    const nextDunning =
      state && row.type === 'invoice'
        ? nextDunningDue({
            eligible: status !== 'cancelled' && row.invoiceKind !== 'cancellation',
            openCents: state.openCents,
            dueDate: row.dueDate ?? row.documentDate,
            notices: row.notices,
            today,
          })
        : null
    if (query.dunning === 'due' && !nextDunning?.due) continue
    if (query.retention === 'true' && !row.plannedRetention && !state?.retentionHeldCents) continue
    const item: InvoiceListItem = {
      id: row.id,
      type: row.type,
      invoiceKind: row.invoiceKind,
      progressNo: row.progressNo,
      number: row.number,
      subject: row.subject,
      documentDate: row.documentDate,
      dueDate: row.dueDate,
      recipient: row.recipient,
      project: { id: row.projectId, number: row.projectNumber, name: row.projectName },
      netCents: Number(row.net),
      grossCents: Number(row.gross),
      paidCents: Number(row.paid),
      adjustedCents: Number(state?.adjustedCents ?? 0n),
      openCents: Number(state?.openCents ?? 0n),
      retentionHeldCents: Number(state?.retentionHeldCents ?? 0n),
      status,
      overdueDays: state?.overdueDays ?? 0,
      hasEinvoice: row.einvoice,
      dunningLevel: row.notices.at(-1)?.level ?? null,
      nextDunning,
    }
    items.push(item)
    if (status === 'draft' || status === 'cancelled') continue
    // A credit note is money owed to the customer: it reduces the sums.
    const sign = row.type === 'credit_note' ? -1 : 1
    sums.count += 1
    sums.netCents += sign * item.netCents
    sums.grossCents += sign * item.grossCents
    sums.paidCents += sign * item.paidCents
    sums.openCents += sign * item.openCents
    if (status === 'overdue' || status === 'dunned') sums.overdueCents += sign * item.openCents
  }
  return { items, sums }
}

const STATUS_LABEL: Record<InvoiceListItem['status'], string> = {
  draft: 'Entwurf',
  open: 'offen',
  partially_paid: 'teilbezahlt',
  paid: 'bezahlt',
  overdue: 'überfällig',
  dunned: 'angemahnt',
  cancelled: 'storniert',
}

const DUNNING_LABEL: Record<DunningLevel, string> = {
  reminder: 'Zahlungserinnerung',
  first: '1. Mahnung',
  final: 'Letzte Mahnung',
}

const KIND_LABEL: Record<string, string> = {
  standard: 'Rechnung',
  partial: 'Teilrechnung',
  progress: 'Abschlagsrechnung',
  final: 'Schlussrechnung',
  cancellation: 'Stornorechnung',
}

export function registerReceivableRoutes(app: FastifyInstance, services: Services) {
  app.post('/api/v1/documents/:id/payments', async (request, reply) => {
    const auth = requirePermission(request, 'payment.write')
    const { id } = parse(idParam, request.params)
    const input = parse(recordPaymentRequest, request.body)
    const receivable = await inTenant(services, auth, async (tx) => {
      const { receivable } = await lockedReceivable(tx, auth, id)
      if (input.paidOn > todayOf(tx)) {
        throw invalid({ paidOn: 'Das Zahlungsdatum liegt in der Zukunft.' })
      }
      const settled = input.settle.reduce((s, a) => s + a.amountCents, 0)
      if (settled > Math.max(0, receivable.openCents - input.amountCents)) {
        throw invalid({ settle: 'Die Abzüge sind höher als der verbleibende Rest der Forderung.' })
      }
      await tx`
        insert into payment (tenant_id, invoice_id, paid_on, amount_cents, method, reference, created_by)
        values (${auth.tenantId}, ${id}, ${input.paidOn}::date, ${input.amountCents}, ${input.method},
                ${input.reference ?? null}, ${auth.userId})`
      for (const adjustment of input.settle) {
        await tx`
          insert into receivable_adjustment (tenant_id, invoice_id, kind, amount_cents, reason, created_by)
          values (${auth.tenantId}, ${id}, ${adjustment.kind}, ${adjustment.amountCents},
                  ${adjustment.kind === 'other' || adjustment.kind === 'short_payment' ? 'Ausgleich beim Zahlungseingang' : null},
                  ${auth.userId})`
      }
      return reloadReceivable(tx, auth, id)
    })
    return reply.status(201).send({ receivable })
  })

  app.post('/api/v1/documents/:id/adjustments', async (request, reply) => {
    const auth = requirePermission(request, 'payment.write')
    const { id } = parse(idParam, request.params)
    const input = parse(recordAdjustmentRequest, request.body)
    const receivable = await inTenant(services, auth, async (tx) => {
      const { receivable } = await lockedReceivable(tx, auth, id)
      if (input.amountCents > receivable.openCents) {
        throw invalid({ amountCents: 'Der Abzug ist höher als die offene Forderung.' })
      }
      await tx`
        insert into receivable_adjustment (tenant_id, invoice_id, kind, amount_cents, reason, disputed, created_by)
        values (${auth.tenantId}, ${id}, ${input.kind}, ${input.amountCents}, ${input.reason ?? null},
                ${input.disputed}, ${auth.userId})`
      return reloadReceivable(tx, auth, id)
    })
    return reply.status(201).send({ receivable })
  })

  // Sicherheitseinbehalt paid out after the warranty period: payment + release of the withheld sum.
  app.post('/api/v1/documents/:id/retention-release', async (request, reply) => {
    const auth = requirePermission(request, 'payment.write')
    const { id } = parse(idParam, request.params)
    const input = parse(releaseRetentionRequest, request.body)
    const receivable = await inTenant(services, auth, async (tx) => {
      const { receivable } = await lockedReceivable(tx, auth, id)
      if (input.amountCents > receivable.retentionHeldCents) {
        throw invalid({
          amountCents: 'Der Betrag ist höher als der einbehaltene Sicherheitseinbehalt.',
        })
      }
      if (input.paidOn > todayOf(tx)) {
        throw invalid({ paidOn: 'Das Zahlungsdatum liegt in der Zukunft.' })
      }
      await tx`
        insert into payment (tenant_id, invoice_id, paid_on, amount_cents, method, reference, created_by)
        values (${auth.tenantId}, ${id}, ${input.paidOn}::date, ${input.amountCents}, ${input.method},
                'Auszahlung Sicherheitseinbehalt', ${auth.userId})`
      await tx`
        insert into receivable_adjustment (tenant_id, invoice_id, kind, amount_cents, reason, created_by)
        values (${auth.tenantId}, ${id}, 'retention', ${-input.amountCents},
                'Auszahlung Sicherheitseinbehalt', ${auth.userId})`
      return reloadReceivable(tx, auth, id)
    })
    return reply.status(201).send({ receivable })
  })

  // Gegenbuchung: entries are never deleted (rule 7); a reversal negates one exactly.
  for (const table of ['payments', 'adjustments'] as const) {
    app.post(`/api/v1/${table}/:id/reverse`, async (request, reply) => {
      const auth = requirePermission(request, 'payment.write')
      const { id } = parse(idParam, request.params)
      const { reason } = parse(reverseEntryRequest, request.body ?? {})
      const receivable = await inTenant(services, auth, async (tx) => {
        const read = () =>
          table === 'payments'
            ? tx<{ invoiceId: string; original: string | null; reversed: boolean }[]>`
                select invoice_id as "invoiceId", reverses_payment_id as original,
                       exists (select 1 from payment r where r.reverses_payment_id = p.id) as reversed
                from payment p where p.id = ${id}`
            : tx<{ invoiceId: string; original: string | null; reversed: boolean }[]>`
                select invoice_id as "invoiceId", reverses_adjustment_id as original,
                       exists (select 1 from receivable_adjustment r where r.reverses_adjustment_id = a.id) as reversed
                from receivable_adjustment a where a.id = ${id}`
        const [found] = await read()
        if (!found) throw notFound('Der Eintrag')
        await lockedReceivable(tx, auth, found.invoiceId, false)
        // Read again under the lock: a concurrent reversal is seen (409 instead of a 500).
        const [entry] = await read()
        if (!entry) throw notFound('Der Eintrag')
        if (entry.original)
          throw new HttpError(409, 'Eine Gegenbuchung kann nicht selbst storniert werden.')
        if (entry.reversed) throw new HttpError(409, 'Der Eintrag ist bereits storniert.')
        const note = `Storno${reason ? `: ${reason}` : ''}`
        if (table === 'payments') {
          await tx`
            insert into payment (tenant_id, invoice_id, paid_on, amount_cents, method, reference,
                                 reverses_payment_id, created_by)
            select tenant_id, invoice_id, ${todayOf(tx)}::date, -amount_cents, method, ${note}, id, ${auth.userId}
            from payment where id = ${id}`
        } else {
          await tx`
            insert into receivable_adjustment (tenant_id, invoice_id, kind, amount_cents, reason,
                                               reverses_adjustment_id, created_by)
            select tenant_id, invoice_id, kind, -amount_cents, ${note}, id, ${auth.userId}
            from receivable_adjustment where id = ${id}`
        }
        return reloadReceivable(tx, auth, entry.invoiceId)
      })
      return reply.status(201).send({ receivable })
    })
  }

  // Kürzung: mark as disputed (bestritten) or accepted; the amount never changes.
  app.patch('/api/v1/adjustments/:id', async (request) => {
    const auth = requirePermission(request, 'payment.write')
    const { id } = parse(idParam, request.params)
    const { disputed } = parse(updateAdjustmentRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      const [entry] = await tx<{ invoiceId: string }[]>`
        select invoice_id as "invoiceId" from receivable_adjustment where id = ${id}`
      if (!entry) throw notFound('Der Eintrag')
      await lockedReceivable(tx, auth, entry.invoiceId, false)
      await tx`update receivable_adjustment set disputed = ${disputed} where id = ${id}`
      return { receivable: await reloadReceivable(tx, auth, entry.invoiceId) }
    })
  })

  app.get('/api/v1/invoices', async (request): Promise<InvoiceList> => {
    const auth = requirePermission(request, 'document.read')
    const query = parse(invoiceListQuery, request.query)
    const { items, sums } = await inTenant(services, auth, (tx) =>
      listInvoices(tx, auth, query, todayIn(services.now())),
    )
    const cursor = decodeCursor(query.cursor, 3)
    const start = cursor
      ? startAfter(items, [
          String(cursor[0]),
          cursor[1] === '' ? null : String(cursor[1]),
          String(cursor[2]),
        ])
      : 0
    const page = items.slice(start, start + query.limit)
    const last = page.at(-1)
    return {
      items: page,
      sums,
      nextCursor:
        last && start + query.limit < items.length
          ? encodeCursor([last.documentDate, last.number ?? '', last.id])
          : null,
    }
  })

  // CSV for Excel (UTF-8 with BOM, semicolon): the filtered list with all rows.
  app.get('/api/v1/invoices/export.csv', async (request, reply) => {
    const auth = requirePermission(request, 'document.read')
    const query = parse(invoiceListQuery, request.query)
    const { items } = await inTenant(services, auth, (tx) =>
      listInvoices(tx, auth, query, todayIn(services.now())),
    )
    const lines = [
      csvLine([
        'Nummer',
        'Art',
        'Rechnungsdatum',
        'Fällig am',
        'Empfänger',
        'Projekt',
        'Netto',
        'Brutto',
        'Bezahlt',
        'Abzüge',
        'Offen',
        'Einbehalt',
        'Status',
        'Mahnstufe',
        'Nächste Mahnstufe ab',
      ]),
      ...items.map((i) =>
        csvLine(
          [
            i.number ?? '',
            i.type === 'credit_note'
              ? 'Gutschrift'
              : (KIND_LABEL[i.invoiceKind ?? 'standard'] ?? 'Rechnung'),
            germanDate(i.documentDate),
            i.dueDate ? germanDate(i.dueDate) : '',
            i.recipient ?? '',
            [i.project.number, i.project.name].filter(Boolean).join(' '),
            germanAmount(i.netCents),
            germanAmount(i.grossCents),
            germanAmount(i.paidCents),
            germanAmount(i.adjustedCents),
            germanAmount(i.openCents),
            germanAmount(i.retentionHeldCents),
            STATUS_LABEL[i.status],
            i.dunningLevel ? DUNNING_LABEL[i.dunningLevel] : '',
            i.nextDunning
              ? `${DUNNING_LABEL[i.nextDunning.level]} ab ${germanDate(i.nextDunning.possibleFrom)}`
              : '',
          ],
          true,
          { spreadsheet: true },
        ),
      ),
    ]
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="Rechnungen_${todayIn(services.now())}.csv"`,
      )
      .header('cache-control', 'no-store')
      .send(`﻿${lines.join('\r\n')}\r\n`)
  })
}
