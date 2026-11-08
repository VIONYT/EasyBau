import { Decimal, type NumericInput, roundQuantity, toDecimal } from '../decimal.js'
import { evaluateFormulaExact, type FormulaVariables } from './formula.js'

/** One measurement line (Aufmaßzeile). Variables of the room are merged with line variables. */
export interface MeasurementLineInput {
  formula: string
  /** Room dimensions (L, B, H …) of the location; line variables override them. */
  locationVariables?: FormulaVariables
  variables?: FormulaVariables
  /** Deduction (e.g. door opening): the absolute value is subtracted. */
  isDeduction?: boolean
}

/**
 * Quantity of one line as stored in `measurement_line.result_qty` (4 decimals).
 * Deductions are negative, so a plain sum gives the net quantity.
 */
export function measurementLineQuantity(line: MeasurementLineInput): string {
  const value = evaluateFormulaExact(line.formula, { ...line.locationVariables, ...line.variables })
  return roundQuantity(line.isDeduction ? value.abs().neg() : value)
}

/** Sums already computed line quantities (strings from the database). */
export function sumQuantities(quantities: readonly NumericInput[]): string {
  return roundQuantity(
    quantities.reduce<Decimal>((sum, q) => sum.plus(toDecimal(q)), new Decimal(0)),
  )
}

/** Groups lines by document item and returns the net quantity per item. */
export function quantitiesByItem(
  lines: readonly { documentItemId: string | null; quantity: NumericInput }[],
): Map<string, string> {
  const sums = new Map<string, Decimal>()
  for (const line of lines) {
    if (!line.documentItemId) continue
    sums.set(
      line.documentItemId,
      (sums.get(line.documentItemId) ?? new Decimal(0)).plus(toDecimal(line.quantity)),
    )
  }
  return new Map([...sums].map(([id, sum]) => [id, roundQuantity(sum)]))
}

/**
 * Quantity to invoice in a progress or final invoice (Mengenfortschreibung, DESIGN.md §4.3):
 * measured to date minus already invoiced. Negative results (over-billed before) are returned
 * as they are, so the invoice shows a credit for that item.
 */
export function billableQuantity(
  cumulativeMeasured: NumericInput,
  previouslyBilled: NumericInput,
): string {
  return roundQuantity(toDecimal(cumulativeMeasured).minus(toDecimal(previouslyBilled)))
}

export interface QuantityVariance {
  /** Measured − contract quantity. */
  difference: string
  /** Deviation in percent of the contract quantity (2 decimals); null if the contract quantity is 0. */
  percent: string | null
  direction: 'more' | 'less' | 'equal'
  /** VOB/B § 2 Abs. 3: deviations beyond ±10 % may justify a new unit price → show a hint. */
  exceedsThreshold: boolean
}

export const VOB_QUANTITY_THRESHOLD_PERCENT = 10

/** Compares measured against contract (LV) quantity for the Mehr-/Mindermengen hint. */
export function quantityVariance(
  contractQuantity: NumericInput,
  measuredQuantity: NumericInput,
): QuantityVariance {
  const contract = toDecimal(contractQuantity)
  const difference = toDecimal(measuredQuantity).minus(contract)
  const direction = difference.isZero() ? 'equal' : difference.isPositive() ? 'more' : 'less'
  if (contract.isZero()) {
    return {
      difference: roundQuantity(difference),
      percent: null,
      direction,
      exceedsThreshold: !difference.isZero(),
    }
  }
  const percent = difference.div(contract.abs()).mul(100)
  return {
    difference: roundQuantity(difference),
    percent: percent.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    direction,
    exceedsThreshold: percent.abs().gt(VOB_QUANTITY_THRESHOLD_PERCENT),
  }
}
