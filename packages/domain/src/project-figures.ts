import { Decimal } from './decimal.js'

/**
 * Projektkennzahlen (DESIGN.md §2 Projekte): Soll-Stunden aus der Kalkulation, Auftragssumme,
 * abgerechnet und offen. Pure sums – the inputs come from the finalized documents of the project.
 */
export interface BilledDocument {
  /** Gutschriften reduce the billed amount. */
  type: 'invoice' | 'credit_note'
  /** Net amount of this document (Abschläge already deducted in final/cumulative invoices). */
  netCents: bigint
  grossCents: bigint
  /** Offene Forderung (receivableState), never negative. */
  openCents: bigint
  /** Received payments (reversals included). */
  paidCents: bigint
}

export interface ProjectFiguresInput {
  /** Vertragssumme netto (Hauptauftrag + beauftragte Nachträge); null without contract. */
  contractNetCents: bigint | null
  /** Soll-Stunden per contract document (decimal strings, e.g. "12.5"). */
  plannedHours: readonly string[]
  /** Counted positions without Kalkulation (not in the Soll-Stunden). */
  uncalculatedCount: number
  /** Finalized, not cancelled invoices and credit notes (no Stornorechnungen). */
  documents: readonly BilledDocument[]
}

export interface ProjectFigures {
  plannedHours: string
  uncalculatedCount: number
  contractNetCents: bigint | null
  billedNetCents: bigint
  billedGrossCents: bigint
  paidCents: bigint
  /** Offene Forderungen (gross). */
  openReceivableCents: bigint
  /** Noch abzurechnen = Vertragssumme − abgerechnet; null without contract, never negative. */
  unbilledNetCents: bigint | null
  /** Abgerechnet über die Vertragssumme hinaus (e.g. free positions, Regie). */
  overbilledNetCents: bigint
  /** Abgerechnet in % der Vertragssumme, one decimal; null without contract sum. */
  billedPercent: string | null
}

export function sumHours(hours: readonly string[]): string {
  return hours
    .reduce((sum, h) => sum.plus(h), new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2)
    .replace(/\.?0+$/, '')
}

export function projectFigures(input: ProjectFiguresInput): ProjectFigures {
  let billedNetCents = 0n
  let billedGrossCents = 0n
  let paidCents = 0n
  let openReceivableCents = 0n
  for (const doc of input.documents) {
    const sign = doc.type === 'credit_note' ? -1n : 1n
    billedNetCents += sign * doc.netCents
    billedGrossCents += sign * doc.grossCents
    paidCents += doc.paidCents
    openReceivableCents += doc.openCents
  }
  const contract = input.contractNetCents
  const rest = contract === null ? null : contract - billedNetCents
  return {
    plannedHours: sumHours(input.plannedHours),
    uncalculatedCount: input.uncalculatedCount,
    contractNetCents: contract,
    billedNetCents,
    billedGrossCents,
    paidCents,
    openReceivableCents,
    unbilledNetCents: rest === null ? null : rest > 0n ? rest : 0n,
    overbilledNetCents: rest !== null && rest < 0n ? -rest : 0n,
    billedPercent:
      contract && contract > 0n
        ? new Decimal(billedNetCents.toString())
            .div(contract.toString())
            .times(100)
            .toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
            .toFixed(1)
        : null,
  }
}
