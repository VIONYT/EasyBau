import { Decimal, toCents } from '../decimal.js'
import { CalculationError } from './item.js'

/**
 * Zielpreis („Preis anpassen“, DESIGN.md §4.2): reach a desired net sum.
 *
 * Calculated positions keep their costs; only the markup part is scaled:
 *   new total = cost + (current total − cost) × k,   k = (target − fixed − Σcost) / (Σcurrent − Σcost)
 * Positions without calculation and locked positions stay fixed. If the adjustable positions have
 * no markup at all, they are scaled proportionally instead. Unit prices are rounded to cents; the
 * remaining rounding difference goes into the largest position. Because GP = quantity × EP, a
 * residual of a few cents can remain – it is reported, never hidden.
 */

export interface TargetPriceItem {
  id: string
  quantity: string
  unitPriceCents: bigint
  totalCents: bigint
  /** Cost of the whole position; null = not calculated (price stays fixed). */
  costCents: bigint | null
  locked?: boolean
}

export interface TargetPriceResult {
  items: { id: string; unitPriceCents: bigint; totalCents: bigint }[]
  netCents: bigint
  /** target − achieved net (rounding remainder). */
  residualCents: bigint
  /** Positions whose new price is below cost (Verkauf unter Kosten). */
  belowCost: string[]
}

function totalFor(quantity: Decimal, unitPriceCents: bigint): bigint {
  return toCents(quantity.mul(unitPriceCents.toString()))
}

export function applyTargetPrice(
  items: readonly TargetPriceItem[],
  targetNetCents: bigint,
): TargetPriceResult {
  if (targetNetCents < 0n) throw new CalculationError('Der Zielpreis darf nicht negativ sein.')
  const adjustable = items.filter(
    (i) => i.costCents !== null && !i.locked && !new Decimal(i.quantity).isZero(),
  )
  if (adjustable.length === 0) {
    throw new CalculationError(
      'Keine kalkulierten Positionen vorhanden, deren Preis angepasst werden kann.',
    )
  }
  const fixed = items.filter((i) => !adjustable.includes(i)).reduce((s, i) => s + i.totalCents, 0n)
  const targetAdjustable = new Decimal((targetNetCents - fixed).toString())
  const cost = adjustable.reduce(
    (s, i) => s.plus((i.costCents as bigint).toString()),
    new Decimal(0),
  )
  const current = adjustable.reduce((s, i) => s.plus(i.totalCents.toString()), new Decimal(0))
  const markup = current.minus(cost)

  const newTotalExact = (item: TargetPriceItem): Decimal => {
    const itemCost = new Decimal((item.costCents as bigint).toString())
    const itemTotal = new Decimal(item.totalCents.toString())
    if (!markup.isZero()) {
      const k = targetAdjustable.minus(cost).div(markup)
      return itemCost.plus(itemTotal.minus(itemCost).mul(k))
    }
    // No markup to scale: distribute proportionally to the current price (or cost if price is 0).
    // (markup = 0 means current = cost; if both are 0, split evenly.)
    if (current.isZero()) return targetAdjustable.div(adjustable.length)
    return itemTotal.div(current).mul(targetAdjustable)
  }

  const updated = new Map<string, { unitPriceCents: bigint; totalCents: bigint }>()
  for (const item of adjustable) {
    const quantity = new Decimal(item.quantity)
    const unitPriceCents = toCents(newTotalExact(item).div(quantity))
    if (unitPriceCents < 0n)
      throw new CalculationError('Der Zielpreis ist zu niedrig: Preise würden negativ.')
    updated.set(item.id, { unitPriceCents, totalCents: totalFor(quantity, unitPriceCents) })
  }

  const achieved = (): bigint =>
    fixed + [...updated.values()].reduce((s, u) => s + u.totalCents, 0n)

  // Put the rounding remainder into the largest adjustable position.
  const largest = adjustable.reduce((a, b) =>
    (updated.get(b.id) as { totalCents: bigint }).totalCents >
    (updated.get(a.id) as { totalCents: bigint }).totalCents
      ? b
      : a,
  )
  const remainder = targetNetCents - achieved()
  if (remainder !== 0n) {
    const quantity = new Decimal(largest.quantity)
    const entry = updated.get(largest.id) as { unitPriceCents: bigint; totalCents: bigint }
    const corrected = toCents(new Decimal((entry.totalCents + remainder).toString()).div(quantity))
    if (corrected >= 0n)
      updated.set(largest.id, {
        unitPriceCents: corrected,
        totalCents: totalFor(quantity, corrected),
      })
  }

  const netCents = achieved()
  return {
    items: items.map((i) => ({
      id: i.id,
      ...(updated.get(i.id) ?? { unitPriceCents: i.unitPriceCents, totalCents: i.totalCents }),
    })),
    netCents,
    residualCents: targetNetCents - netCents,
    belowCost: adjustable
      .filter(
        (i) => (updated.get(i.id) as { totalCents: bigint }).totalCents < (i.costCents as bigint),
      )
      .map((i) => i.id),
  }
}

/** Alternative without redistribution: a separate adjustment line (positive = surcharge, negative = discount). */
export function targetPriceAdjustmentLine(currentNetCents: bigint, targetNetCents: bigint): bigint {
  return targetNetCents - currentNetCents
}
