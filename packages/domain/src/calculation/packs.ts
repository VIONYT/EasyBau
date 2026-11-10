import { Decimal, type NumericInput, toDecimal } from '../decimal.js'
import { CalculationError } from './item.js'

/**
 * Material demand in packages (Gebinde, DESIGN.md §4.2.1):
 *   demand = consumption per unit × position quantity, packs = ceil(demand / pack size)
 * e.g. 4 kg/m² × 37,5 m² = 150 kg, Sack 25 kg → 6 Säcke.
 */
export interface PackDemand {
  /** Required amount in the consumption unit (4 decimals). */
  demand: string
  /** Number of packs; rounded up unless rounding is switched off. */
  packs: string
  /** Leftover in the consumption unit when rounding up (4 decimals). */
  surplus: string
}

export function packDemand(input: {
  consumptionPerUnit: NumericInput
  quantity: NumericInput
  packSize: NumericInput
  roundUpToWholePacks?: boolean
}): PackDemand {
  const packSize = toDecimal(input.packSize)
  if (packSize.lte(0)) throw new CalculationError('Der Gebindeinhalt muss größer als 0 sein.')
  const demand = toDecimal(input.consumptionPerUnit).mul(toDecimal(input.quantity))
  if (demand.isNegative()) throw new CalculationError('Der Materialbedarf darf nicht negativ sein.')
  const exactPacks = demand.div(packSize)
  const packs = input.roundUpToWholePacks === false ? exactPacks : exactPacks.ceil()
  return {
    demand: demand.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
    packs: packs.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
    surplus: packs.mul(packSize).minus(demand).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
  }
}
