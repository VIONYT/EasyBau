import {
  Decimal,
  type NumericInput,
  percentToFactor,
  roundQuantity,
  toCents,
  toDecimal,
} from '../decimal.js'
import { convertUnit, isConvertible } from '../units.js'

/**
 * Calculation of a single position (DESIGN.md §4.2).
 *
 * Cost lines (Kostenzeilen) per position: kind, quantity, unit, unit cost.
 *   unit_price mode:  cost lines describe ONE unit of the position.
 *                     EP = round(Σ qty × cost × (1 + markup)),  GP = round(quantity × EP)
 *   total_price mode: cost lines describe the WHOLE position quantity.
 *                     GP = round(Σ qty × cost × (1 + markup)),  EP = round(GP / quantity)
 * Money is returned as bigint cents (rule 1); intermediate values stay exact (Decimal).
 */

export type CostKind = 'labor' | 'material' | 'equipment' | 'subcontract' | 'other'
export const COST_KINDS: readonly CostKind[] = [
  'labor',
  'material',
  'equipment',
  'subcontract',
  'other',
]

/** Default surcharges per cost kind in percent (Einstellungen › Zuschläge). */
export type Surcharges = Partial<Record<CostKind, NumericInput>>

export interface CostLineInput {
  kind: CostKind
  quantity: NumericInput
  /** Unit symbol of the quantity (e.g. "min", "Std", "kg"); used for labor time. */
  unit?: string
  /** Cost per unit in cents, may be fractional for very small units (e.g. 75 = 0,75 €/min). */
  unitCostCents: NumericInput
  /** Overrides the default surcharge of the kind, in percent. */
  markupPercent?: NumericInput
}

export interface ItemCalculationInput {
  quantity: NumericInput
  calcMode?: 'unit_price' | 'total_price'
  costLines: readonly CostLineInput[]
  surcharges?: Surcharges
  /** Line discount in percent (Rabatt je Position). */
  discountPercent?: NumericInput
}

export interface KindBreakdown {
  /** Cost of this kind for the whole position (cents, exact up to 4 decimals). */
  costCents: string
  /** Selling value of this kind for the whole position (cents, exact up to 4 decimals). */
  sellCents: string
}

export interface ItemCalculation {
  /** Einheitspreis (EP) in cents. */
  unitPriceCents: bigint
  /** Gesamtpreis (GP) before line discount, in cents. */
  grossLineCents: bigint
  /** Line discount in cents (positive number). */
  discountCents: bigint
  /** Gesamtpreis after discount = net value of the position. */
  totalCents: bigint
  /** Total cost of the position in cents (rounded). */
  costCents: bigint
  /** totalCents − costCents. */
  marginCents: bigint
  /** Margin in percent of the selling price (2 decimals), null if the price is 0. */
  marginPercent: string | null
  /** Planned labor hours for the whole position (Soll-Stunden), 4 decimals. */
  laborHours: string
  /** Net labor share of the position after line discount (for § 35a EStG), in cents. */
  laborShareCents: bigint
  byKind: Record<CostKind, KindBreakdown>
}

export class CalculationError extends Error {
  override name = 'CalculationError'
}

function markupFactor(line: CostLineInput, surcharges: Surcharges): Decimal {
  const percent = line.markupPercent ?? surcharges[line.kind] ?? 0
  const factor = percentToFactor(percent)
  if (factor.lte(-1))
    throw new CalculationError('Ein Zuschlag von −100 % oder weniger ist nicht möglich.')
  return factor.plus(1)
}

/** Labor hours represented by one cost line (time units are converted; other units count as hours). */
function lineHours(line: CostLineInput, multiplier: Decimal): Decimal {
  if (line.kind !== 'labor') return new Decimal(0)
  const quantity = toDecimal(line.quantity).mul(multiplier)
  if (line.unit && isConvertible(line.unit, 'Std')) return convertUnit(quantity, line.unit, 'Std')
  return quantity
}

export function calculateItem(input: ItemCalculationInput): ItemCalculation {
  const quantity = toDecimal(input.quantity)
  const mode = input.calcMode ?? 'unit_price'
  const surcharges = input.surcharges ?? {}
  if (mode === 'total_price' && quantity.isZero() && input.costLines.length > 0) {
    throw new CalculationError('Im Modus „Gesamtpreis“ muss die Menge größer als 0 sein.')
  }

  // Factor that scales the cost lines to the whole position.
  const toPosition = mode === 'unit_price' ? quantity : new Decimal(1)

  const byKind = Object.fromEntries(
    COST_KINDS.map((k) => [k, { cost: new Decimal(0), sell: new Decimal(0) }]),
  ) as Record<CostKind, { cost: Decimal; sell: Decimal }>
  let sellPerBasis = new Decimal(0) // per unit (unit_price) or per position (total_price)
  let laborHours = new Decimal(0)

  for (const line of input.costLines) {
    const cost = toDecimal(line.quantity).mul(toDecimal(line.unitCostCents))
    if (cost.isNegative()) throw new CalculationError('Kosten dürfen nicht negativ sein.')
    const sell = cost.mul(markupFactor(line, surcharges))
    sellPerBasis = sellPerBasis.plus(sell)
    const bucket = byKind[line.kind]
    bucket.cost = bucket.cost.plus(cost.mul(toPosition))
    bucket.sell = bucket.sell.plus(sell.mul(toPosition))
    laborHours = laborHours.plus(lineHours(line, toPosition))
  }

  let unitPriceCents: bigint
  let grossLineCents: bigint
  if (mode === 'unit_price') {
    unitPriceCents = toCents(sellPerBasis)
    grossLineCents = toCents(quantity.mul(unitPriceCents.toString()))
  } else {
    grossLineCents = toCents(sellPerBasis)
    unitPriceCents = quantity.isZero()
      ? 0n
      : toCents(new Decimal(grossLineCents.toString()).div(quantity))
  }

  const discount =
    input.discountPercent === undefined ? new Decimal(0) : percentToFactor(input.discountPercent)
  if (discount.isNegative() || discount.gt(1))
    throw new CalculationError('Rabatt muss zwischen 0 und 100 % liegen.')
  const discountCents = toCents(new Decimal(grossLineCents.toString()).mul(discount))
  const totalCents = grossLineCents - discountCents
  const costCents = toCents(COST_KINDS.reduce((s, k) => s.plus(byKind[k].cost), new Decimal(0)))
  const totalSell = COST_KINDS.reduce((s, k) => s.plus(byKind[k].sell), new Decimal(0))
  // Labor share follows the rounded price: its fraction of the selling value, applied to the total.
  const laborShareCents = totalSell.isZero()
    ? 0n
    : toCents(byKind.labor.sell.div(totalSell).mul(totalCents.toString()))
  const marginCents = totalCents - costCents

  return {
    unitPriceCents,
    grossLineCents,
    discountCents,
    totalCents,
    costCents,
    marginCents,
    marginPercent:
      totalCents === 0n
        ? null
        : new Decimal(marginCents.toString())
            .div(totalCents.toString())
            .mul(100)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .toFixed(2),
    laborHours: roundQuantity(laborHours),
    laborShareCents,
    byKind: Object.fromEntries(
      COST_KINDS.map((k) => [
        k,
        {
          costCents: byKind[k].cost.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
          sellCents: byKind[k].sell.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
        },
      ]),
    ) as Record<CostKind, KindBreakdown>,
  }
}

/** Price without cost lines (position priced directly): GP = round(quantity × EP). */
export function priceItem(input: {
  quantity: NumericInput
  unitPriceCents: NumericInput
  discountPercent?: NumericInput
}): Pick<ItemCalculation, 'unitPriceCents' | 'grossLineCents' | 'discountCents' | 'totalCents'> {
  const unitPriceCents = toCents(toDecimal(input.unitPriceCents))
  const grossLineCents = toCents(toDecimal(input.quantity).mul(unitPriceCents.toString()))
  const discount =
    input.discountPercent === undefined ? new Decimal(0) : percentToFactor(input.discountPercent)
  if (discount.isNegative() || discount.gt(1))
    throw new CalculationError('Rabatt muss zwischen 0 und 100 % liegen.')
  const discountCents = toCents(new Decimal(grossLineCents.toString()).mul(discount))
  return {
    unitPriceCents,
    grossLineCents,
    discountCents,
    totalCents: grossLineCents - discountCents,
  }
}

/** Stundenverrechnungssatz of a wage group: cost per hour × (1 + markup). */
export function hourlyRateCents(
  costPerHourCents: NumericInput,
  markupPercent: NumericInput = 0,
): bigint {
  return toCents(toDecimal(costPerHourCents).mul(percentToFactor(markupPercent).plus(1)))
}

/** Converts an hourly cost/rate to another time unit, e.g. 4500 ct/Std → 75 ct/min. */
export function rateForTimeUnit(centsPerHour: NumericInput, unit: string): Decimal {
  // A rate per unit converts inversely to the quantity: 1 Std = 60 min → rate/60.
  return toDecimal(centsPerHour).div(convertUnit(1, 'Std', unit))
}
