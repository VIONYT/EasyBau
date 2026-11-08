import { Decimal, type NumericInput, percentToFactor, toCents, toDecimal } from '../decimal.js'
import { CalculationError } from './item.js'

/**
 * Document totals (Angebot, Rechnung, …): title subtotals, document discount, VAT per rate,
 * retention / construction levy, cash discount, § 35a labor share.
 *
 * VAT is computed per tax category and rate on the SUM of the line nets (EN 16931, rule 1),
 * not per line. Alternative and optional positions are printed but never summed.
 */

export type PositionType =
  | 'title'
  | 'item'
  | 'alternative'
  | 'optional'
  | 'lump_sum'
  | 'text'
  | 'subtotal'
  | 'image'
export type TaxCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O' | 'L' | 'M'
export type TaxMode = 'standard' | 'reverse_charge_13b' | 'small_business' | 'intra_eu' | 'export'

export interface DocumentLineInput {
  id: string
  parentId?: string | null
  positionType: PositionType
  /** Net value of the position after line discount (cents). Ignored for non-priced types. */
  totalCents?: bigint
  /** VAT rate of the position in percent (standard tax mode only). */
  taxRatePercent?: NumericInput
  taxCategory?: TaxCategory
  /** Net labor share (§ 35a) of the position in cents. */
  laborShareCents?: bigint
}

export interface DocumentTotalsInput {
  lines: readonly DocumentLineInput[]
  taxMode?: TaxMode
  /** Document-level discount in percent (Gesamtrabatt). */
  discountPercent?: NumericInput
  /** Sicherheitseinbehalt in percent of the gross amount. */
  retentionPercent?: NumericInput
  /** Bauumlage in percent of the gross amount. */
  constructionLevyPercent?: NumericInput
  /** Skonto in percent of the payable amount (shown as information, not deducted). */
  cashDiscountPercent?: NumericInput
}

export interface TaxLine {
  category: TaxCategory
  ratePercent: string
  netCents: bigint
  taxCents: bigint
  /** Required text for VAT-exempt categories (BT-120), German. */
  exemptionReason?: string
}

export interface DocumentTotals {
  /** Sum of all counted positions before document discount. */
  itemsNetCents: bigint
  discountCents: bigint
  netCents: bigint
  taxCents: bigint
  grossCents: bigint
  taxLines: TaxLine[]
  retentionCents: bigint
  constructionLevyCents: bigint
  /** Gross − retention − construction levy. */
  payableCents: bigint
  cashDiscountCents: bigint
  /** Subtotal per title id (counted positions below the title, before document discount). */
  titleSubtotals: Map<string, bigint>
  /** § 35a EStG: labor share net and incl. VAT after document discount. */
  laborShare: { netCents: bigint; grossCents: bigint }
}

/** Position types that count towards the document sum. */
export const COUNTED_POSITION_TYPES: ReadonlySet<PositionType> = new Set(['item', 'lump_sum'])

/** German exemption texts printed on the invoice and written to BT-120. */
export const EXEMPTION_REASONS: Partial<Record<TaxCategory, string>> = {
  AE: 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG).',
  E: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
  K: 'Steuerfreie innergemeinschaftliche Leistung.',
  G: 'Steuerfreie Ausfuhrlieferung.',
}

const MODE_CATEGORY: Record<Exclude<TaxMode, 'standard'>, TaxCategory> = {
  reverse_charge_13b: 'AE',
  small_business: 'E',
  intra_eu: 'K',
  export: 'G',
}

function percentOrZero(value: NumericInput | undefined, label: string): Decimal {
  if (value === undefined) return new Decimal(0)
  const factor = percentToFactor(value)
  if (factor.isNegative() || factor.gt(1))
    throw new CalculationError(`${label} muss zwischen 0 und 100 % liegen.`)
  return factor
}

function lineTax(line: DocumentLineInput, mode: TaxMode): { category: TaxCategory; rate: Decimal } {
  if (mode !== 'standard') return { category: MODE_CATEGORY[mode], rate: new Decimal(0) }
  if (line.taxRatePercent === undefined) {
    throw new CalculationError(`Position ${line.id}: Steuersatz fehlt.`)
  }
  const rate = toDecimal(line.taxRatePercent)
  return { category: line.taxCategory ?? (rate.isZero() ? 'Z' : 'S'), rate }
}

/** Collects all ancestors of a line, to add its value to every enclosing title. */
function ancestorsOf(line: DocumentLineInput, byId: Map<string, DocumentLineInput>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  let parentId = line.parentId ?? null
  while (parentId) {
    if (seen.has(parentId)) throw new CalculationError('Die Gliederung enthält einen Zirkelbezug.')
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) throw new CalculationError(`Übergeordneter Titel ${parentId} fehlt.`)
    if (parent.positionType === 'title') result.push(parent.id)
    parentId = parent.parentId ?? null
  }
  return result
}

export function calculateDocumentTotals(input: DocumentTotalsInput): DocumentTotals {
  const mode = input.taxMode ?? 'standard'
  const discount = percentOrZero(input.discountPercent, 'Der Gesamtrabatt')
  const byId = new Map(input.lines.map((l) => [l.id, l]))

  const titleSubtotals = new Map<string, bigint>()
  for (const line of input.lines) if (line.positionType === 'title') titleSubtotals.set(line.id, 0n)

  // Group counted lines by (category, rate).
  const groups = new Map<
    string,
    { category: TaxCategory; rate: Decimal; net: bigint; labor: bigint }
  >()
  let itemsNetCents = 0n
  for (const line of input.lines) {
    if (!COUNTED_POSITION_TYPES.has(line.positionType)) continue
    const total = line.totalCents ?? 0n
    itemsNetCents += total
    for (const titleId of ancestorsOf(line, byId)) {
      titleSubtotals.set(titleId, (titleSubtotals.get(titleId) as bigint) + total)
    }
    const { category, rate } = lineTax(line, mode)
    const key = `${category}|${rate.toFixed(4)}`
    const group = groups.get(key) ?? { category, rate, net: 0n, labor: 0n }
    group.net += total
    group.labor += line.laborShareCents ?? 0n
    groups.set(key, group)
  }

  const taxLines: TaxLine[] = []
  let discountCents = 0n
  let laborNet = 0n
  let laborGross = 0n
  const ordered = [...groups.values()].sort(
    (a, b) => b.rate.comparedTo(a.rate) || a.category.localeCompare(b.category),
  )
  for (const group of ordered) {
    // The document discount is applied per tax group (document-level allowance per category).
    const groupDiscount = toCents(new Decimal(group.net.toString()).mul(discount))
    const net = group.net - groupDiscount
    discountCents += groupDiscount
    const tax = toCents(new Decimal(net.toString()).mul(group.rate).div(100))
    const reason = EXEMPTION_REASONS[group.category]
    taxLines.push({
      category: group.category,
      ratePercent: group.rate.toFixed(2),
      netCents: net,
      taxCents: tax,
      ...(reason ? { exemptionReason: reason } : {}),
    })
    const labor = toCents(new Decimal(group.labor.toString()).mul(new Decimal(1).minus(discount)))
    laborNet += labor
    laborGross += labor + toCents(new Decimal(labor.toString()).mul(group.rate).div(100))
  }

  const netCents = itemsNetCents - discountCents
  const taxCents = taxLines.reduce((sum, t) => sum + t.taxCents, 0n)
  const grossCents = netCents + taxCents
  const gross = new Decimal(grossCents.toString())
  const retentionCents = toCents(
    gross.mul(percentOrZero(input.retentionPercent, 'Der Sicherheitseinbehalt')),
  )
  const constructionLevyCents = toCents(
    gross.mul(percentOrZero(input.constructionLevyPercent, 'Die Bauumlage')),
  )
  const payableCents = grossCents - retentionCents - constructionLevyCents
  const cashDiscountCents = toCents(
    new Decimal(payableCents.toString()).mul(
      percentOrZero(input.cashDiscountPercent, 'Das Skonto'),
    ),
  )

  return {
    itemsNetCents,
    discountCents,
    netCents,
    taxCents,
    grossCents,
    taxLines,
    retentionCents,
    constructionLevyCents,
    payableCents,
    cashDiscountCents,
    titleSubtotals,
    laborShare: { netCents: laborNet, grossCents: laborGross },
  }
}
