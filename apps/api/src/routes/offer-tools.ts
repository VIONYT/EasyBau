import {
  CalculationError,
  COUNTED_POSITION_TYPES,
  Decimal,
  type PositionType,
  scaleMarkupPercent,
  targetPriceRatios,
  toCents,
} from '@easybau/domain'
import { type TargetPriceResult, targetPriceRequest } from '@easybau/schemas'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { inTenant, requirePermission, type Services } from '../context.js'
import { HttpError, notFound, parse } from '../http.js'
import { copyItems, loadDocument, lockDraft, recalculate, sendDocument } from './documents.js'

/**
 * Angebot (P2.12): Zielpreis („Preis anpassen“) and Angebotsversionen.
 *
 * Zielpreis: positions with Kalkulation keep their costs; the Zuschläge of their cost lines are
 * scaled so the net total reaches the target (domain `targetPriceRatios`). Positions without
 * Kalkulation and locked positions keep their price. After recalculating, the remaining
 * rounding difference (EP × Menge) is reported, never hidden.
 */

const idParam = z.object({ id: z.uuid('Ungültige ID.') })

/** Document types whose prices may be adjusted to a target (not invoices: prices from the contract). */
const ADJUSTABLE_TYPES = ['quote', 'cost_estimate', 'order_confirmation', 'change_order']
/** Document types with versions. */
const VERSIONED_TYPES = ['quote', 'cost_estimate']

export function registerOfferToolRoutes(app: FastifyInstance, services: Services) {
  app.post('/api/v1/documents/:id/target-price', async (request): Promise<TargetPriceResult> => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(idParam, request.params)
    const input = parse(targetPriceRequest, request.body)
    return inTenant(services, auth, async (tx) => {
      await lockDraft(tx, auth, id)
      const doc = await loadDocument(tx, auth, id)
      if (!doc) throw notFound('Das Dokument')
      if (!ADJUSTABLE_TYPES.includes(doc.type)) {
        throw new HttpError(
          409,
          'Einen Zielpreis gibt es nur für Angebote, Kostenvoranschläge, Aufträge und Nachträge.',
        )
      }
      const counted = doc.items.filter(
        (i) => COUNTED_POSITION_TYPES.has(i.positionType as PositionType) && i.totalCents !== null,
      )
      const locked = new Set(input.lockedItemIds)
      // Target of the positions: the document discount (Gesamtrabatt) applies afterwards.
      const discount = new Decimal(doc.discountPercent ?? '0').div(100)
      if (discount.gte(1)) throw new HttpError(409, 'Bei 100 % Rabatt gibt es keinen Zielpreis.')
      const itemsTarget = toCents(
        new Decimal(input.targetNetCents).div(new Decimal(1).minus(discount)),
      )
      let result: ReturnType<typeof targetPriceRatios>
      try {
        result = targetPriceRatios(
          counted.map((i) => ({
            id: i.id,
            quantity: i.quantity ?? '0',
            unitPriceCents: BigInt(i.unitPriceCents ?? 0),
            totalCents: BigInt(i.totalCents ?? 0),
            costCents: i.calculation ? BigInt(i.calculation.costCents) : null,
            locked: locked.has(i.id),
          })),
          itemsTarget,
        )
      } catch (error) {
        if (error instanceof CalculationError) {
          throw new HttpError(409, error.message, { targetNetCents: error.message })
        }
        throw error
      }
      const belowCost = counted
        .filter((i) => result.belowCost.includes(i.id))
        .map((i) => ({ id: i.id, oz: i.oz, shortText: i.shortText }))
      const fixedCount = counted.length - result.ratios.size
      if (!input.apply) {
        // Estimate: exact new totals before rounding of the unit prices.
        let items = 0n
        for (const i of counted) {
          const ratio = result.ratios.get(i.id)
          items += ratio ? toCents(ratio.mul(i.totalCents ?? 0)) : BigInt(i.totalCents ?? 0)
        }
        const net = Number(items - toCents(new Decimal(items.toString()).mul(discount)))
        return {
          currentNetCents: doc.totals.netCents,
          targetNetCents: input.targetNetCents,
          netCents: net,
          residualCents: input.targetNetCents - net,
          adjustedCount: result.ratios.size,
          fixedCount,
          belowCost,
          applied: false,
          document: null,
        }
      }
      try {
        for (const item of counted) {
          const ratio = result.ratios.get(item.id)
          if (!ratio) continue
          for (const line of item.costLines) {
            await tx`update item_calc_component set markup_percent = ${scaleMarkupPercent(line.markupPercent, ratio)}
                     where id = ${line.id}`
          }
        }
      } catch (error) {
        if (error instanceof CalculationError) {
          throw new HttpError(409, error.message, { targetNetCents: error.message })
        }
        throw error
      }
      await recalculate(tx, id)
      const updated = await loadDocument(tx, auth, id)
      if (!updated) throw notFound('Das Dokument')
      return {
        currentNetCents: doc.totals.netCents,
        targetNetCents: input.targetNetCents,
        netCents: updated.totals.netCents,
        residualCents: input.targetNetCents - updated.totals.netCents,
        adjustedCount: result.ratios.size,
        fixedCount,
        belowCost,
        applied: true,
        document: updated,
      }
    })
  })

  /** Neue Version eines fertiggestellten Angebots: a draft copy; the old version stays unchanged. */
  app.post('/api/v1/documents/:id/versions', async (request, reply) => {
    const auth = requirePermission(request, 'document.write')
    const { id } = parse(idParam, request.params)
    const doc = await inTenant(services, auth, async (tx) => {
      const source = await loadDocument(tx, auth, id)
      if (!source) throw notFound('Das Dokument')
      if (!VERSIONED_TYPES.includes(source.type)) {
        throw new HttpError(409, 'Versionen gibt es für Angebote und Kostenvoranschläge.')
      }
      if (source.status === 'draft') {
        throw new HttpError(
          409,
          'Den Entwurf bitte direkt bearbeiten; eine neue Version entsteht aus dem fertigen Angebot.',
        )
      }
      await tx`select id from document where id = ${id} for update`
      const [newer] = await tx<{ id: string }[]>`
        select id from document where previous_version_id = ${id}`
      if (newer) {
        throw new HttpError(409, 'Zu diesem Angebot gibt es schon eine neuere Version.', {
          versionId: newer.id,
        })
      }
      const [created] = await tx<{ id: string }[]>`
        insert into document (tenant_id, project_id, type, subject, place_of_performance, contact_id,
                              contact_person_id, tax_mode, currency, intro_text, closing_text, payment_due_days,
                              cash_discount_percent, cash_discount_days, discount_percent, retention_percent,
                              construction_levy_percent, show_labor_share, version, previous_version_id, created_by)
        select tenant_id, project_id, type, subject, place_of_performance, contact_id,
               contact_person_id, tax_mode, currency, intro_text, closing_text, payment_due_days,
               cash_discount_percent, cash_discount_days, discount_percent, retention_percent,
               construction_levy_percent, show_labor_share, version + 1, id, ${auth.userId}
        from document where id = ${id}
        returning id`
      const newId = (created as { id: string }).id
      await copyItems(tx, id, newId)
      await recalculate(tx, newId)
      return loadDocument(tx, auth, newId)
    })
    return sendDocument(reply, doc, 201)
  })
}
