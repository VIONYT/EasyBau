import type { Requirement } from './calculation/billing.js'
import { toDecimal } from './decimal.js'

/**
 * Eingangsrechnungen (P1.11): checks before "Prüfung bestätigen" and the split of the input tax
 * over the cost allocations. No bookkeeping: the allocation says which project or business area
 * the costs belong to and of which kind; accounts only appear in the DATEV export.
 */

export const COST_TYPES = ['material', 'labor', 'equipment', 'subcontract', 'other'] as const
export type CostType = (typeof COST_TYPES)[number]

export interface IncomingTaxLine {
  /** VAT rate in percent, e.g. "19" or "7.00". */
  ratePercent: string
  netCents: bigint
  taxCents: bigint
}

export interface IncomingAllocation {
  projectId: string | null
  businessAreaId: string | null
  costType: CostType
  ratePercent: string
  netCents: bigint
}

export interface IncomingCheckInput {
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  netCents: bigint
  taxCents: bigint
  grossCents: bigint
  /** § 13b UStG: the recipient owes the VAT, the invoice shows none. */
  reverseCharge: boolean
  taxLines: readonly IncomingTaxLine[]
  allocations: readonly IncomingAllocation[]
}

/** Normalized rate key: "19.00" and "19" are the same rate. */
export const rateKey = (rate: string): string => toDecimal(rate).toString()

const euro = (cents: bigint) =>
  `${cents < 0n ? '-' : ''}${(cents < 0n ? -cents : cents) / 100n},${String((cents < 0n ? -cents : cents) % 100n).padStart(2, '0')} €`

/** Blocking problems before the review can be confirmed (German messages); empty = complete. */
export function incomingProblems(input: IncomingCheckInput): Requirement[] {
  const problems: Requirement[] = []
  if (!input.supplierName?.trim()) {
    problems.push({ field: 'supplierName', message: 'Der Lieferant fehlt.' })
  }
  if (!input.invoiceNumber?.trim()) {
    problems.push({ field: 'invoiceNumber', message: 'Die Rechnungsnummer des Lieferanten fehlt.' })
  }
  if (!input.invoiceDate) {
    problems.push({ field: 'invoiceDate', message: 'Das Rechnungsdatum fehlt.' })
  } else if (input.dueDate && input.dueDate < input.invoiceDate) {
    problems.push({ field: 'dueDate', message: 'Die Fälligkeit liegt vor dem Rechnungsdatum.' })
  }
  if (input.grossCents <= 0n) {
    problems.push({ field: 'grossCents', message: 'Der Bruttobetrag muss größer als 0 sein.' })
  }
  if (input.netCents + input.taxCents !== input.grossCents) {
    problems.push({
      field: 'grossCents',
      message: `Netto + Umsatzsteuer ergibt ${euro(input.netCents + input.taxCents)}, nicht ${euro(input.grossCents)}.`,
    })
  }
  if (input.reverseCharge && input.taxCents !== 0n) {
    problems.push({
      field: 'reverseCharge',
      message:
        'Bei Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG) weist die Rechnung keine Umsatzsteuer aus.',
    })
  }

  const rates = new Map<string, IncomingTaxLine>()
  if (!input.taxLines.length) {
    problems.push({
      field: 'taxLines',
      message: 'Mindestens ein Steuersatz mit Nettobetrag fehlt.',
    })
  }
  for (const line of input.taxLines) {
    const key = rateKey(line.ratePercent)
    if (rates.has(key)) {
      problems.push({
        field: 'taxLines',
        message: `Der Steuersatz ${key} % ist doppelt angegeben.`,
      })
    }
    rates.set(key, line)
  }
  const sum = (values: readonly bigint[]) => values.reduce((a, b) => a + b, 0n)
  if (input.taxLines.length) {
    const net = sum(input.taxLines.map((l) => l.netCents))
    const tax = sum(input.taxLines.map((l) => l.taxCents))
    if (net !== input.netCents) {
      problems.push({
        field: 'taxLines',
        message: `Die Nettobeträge je Steuersatz ergeben ${euro(net)}, nicht ${euro(input.netCents)}.`,
      })
    }
    if (tax !== input.taxCents) {
      problems.push({
        field: 'taxLines',
        message: `Die Umsatzsteuer je Steuersatz ergibt ${euro(tax)}, nicht ${euro(input.taxCents)}.`,
      })
    }
  }

  if (!input.allocations.length) {
    problems.push({
      field: 'allocations',
      message: 'Die Kosten sind noch keinem Projekt oder Betriebsbereich zugewiesen.',
    })
  }
  const allocated = new Map<string, bigint>()
  input.allocations.forEach((allocation, index) => {
    const field = `allocations.${index}`
    if ((allocation.projectId === null) === (allocation.businessAreaId === null)) {
      problems.push({
        field,
        message: 'Bitte genau ein Projekt oder einen Betriebsbereich wählen.',
      })
    }
    if (allocation.netCents <= 0n) {
      problems.push({ field, message: 'Der zugewiesene Betrag muss größer als 0 sein.' })
    }
    const key = rateKey(allocation.ratePercent)
    if (!rates.has(key)) {
      problems.push({ field, message: `Der Steuersatz ${key} % kommt in der Rechnung nicht vor.` })
    }
    allocated.set(key, (allocated.get(key) ?? 0n) + allocation.netCents)
  })
  if (input.allocations.length) {
    for (const [key, line] of rates) {
      const done = allocated.get(key) ?? 0n
      if (done !== line.netCents) {
        const rest = line.netCents - done
        problems.push({
          field: 'allocations',
          message:
            rest > 0n
              ? `Zum Steuersatz ${key} % sind noch ${euro(rest)} netto nicht zugewiesen.`
              : `Zum Steuersatz ${key} % sind ${euro(-rest)} netto zu viel zugewiesen.`,
        })
      }
    }
  }
  return problems
}

/** Hints that do not block confirming (e.g. VAT that does not match the rate). */
export function incomingWarnings(input: IncomingCheckInput): Requirement[] {
  const warnings: Requirement[] = []
  for (const line of input.taxLines) {
    if (input.reverseCharge) continue
    const expected = toDecimal(line.netCents).times(toDecimal(line.ratePercent)).div(100)
    if (expected.minus(toDecimal(line.taxCents)).abs().greaterThan(1)) {
      warnings.push({
        field: 'taxLines',
        message: `Die Umsatzsteuer zu ${rateKey(line.ratePercent)} % passt nicht zum Nettobetrag – bitte mit der Rechnung vergleichen.`,
      })
    }
  }
  return warnings
}

/**
 * Splits the input tax of each rate over the allocations of that rate, proportional to their net
 * amount; rounding differences go to the largest remainders, so the sum per rate is exact.
 */
export function allocationTax(
  allocations: readonly IncomingAllocation[],
  taxLines: readonly IncomingTaxLine[],
): bigint[] {
  const result = allocations.map(() => 0n)
  for (const line of taxLines) {
    const key = rateKey(line.ratePercent)
    const members = allocations
      .map((allocation, index) => ({ allocation, index }))
      .filter(({ allocation }) => rateKey(allocation.ratePercent) === key)
    const totalNet = members.reduce((s, m) => s + m.allocation.netCents, 0n)
    if (!members.length || totalNet === 0n) continue
    let distributed = 0n
    const remainders = members.map(({ allocation, index }) => {
      const exact = line.taxCents * allocation.netCents
      const share = exact / totalNet
      result[index] = share
      distributed += share
      return { index, remainder: exact % totalNet }
    })
    remainders.sort((a, b) =>
      b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index,
    )
    let left = line.taxCents - distributed
    for (const { index } of remainders) {
      if (left === 0n) break
      result[index] = (result[index] as bigint) + 1n
      left -= 1n
    }
  }
  return result
}
