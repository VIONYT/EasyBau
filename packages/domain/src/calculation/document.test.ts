import { describe, expect, it } from 'vitest'
import { calculateDocumentTotals, type DocumentLineInput } from './document.js'
import { applyTargetPrice, targetPriceAdjustmentLine } from './target-price.js'

const item = (
  id: string,
  totalCents: bigint,
  extra: Partial<DocumentLineInput> = {},
): DocumentLineInput => ({
  id,
  positionType: 'item',
  totalCents,
  taxRatePercent: 19,
  ...extra,
})

describe('document totals', () => {
  it('sums items, titles and VAT; ignores alternative, optional and text lines', () => {
    const totals = calculateDocumentTotals({
      lines: [
        { id: 't1', positionType: 'title' },
        item('1.1', 50000n, { parentId: 't1' }),
        { id: 't1.1', positionType: 'title', parentId: 't1' },
        item('1.1.1', 12500n, { parentId: 't1.1' }),
        item('1.2', 99900n, { parentId: 't1', positionType: 'alternative' }),
        item('1.3', 10000n, { parentId: 't1', positionType: 'optional' }),
        { id: 'x', positionType: 'text' },
        { id: 't2', positionType: 'title' },
        item('2.1', 15000n, { parentId: 't2', positionType: 'lump_sum' }),
      ],
    })
    expect(totals.itemsNetCents).toBe(77500n)
    expect(totals.taxLines).toEqual([
      { category: 'S', ratePercent: '19.00', netCents: 77500n, taxCents: 14725n },
    ])
    expect(totals.grossCents).toBe(92225n)
    expect(Object.fromEntries(totals.titleSubtotals)).toEqual({
      t1: 62500n,
      't1.1': 12500n,
      t2: 15000n,
    })
  })

  it('computes VAT on the sum per rate, not per line (EN 16931)', () => {
    // Per line: 3 × round(0,05 × 0,19) = 3 × 0,01 = 0,03; on the sum: round(0,15 × 0,19) = 0,03 → equal here,
    // but 7 × 0,07 € lines: per line 7 × 0,01 = 0,07; on the sum round(0,49 × 0,19 = 0,0931) = 0,09.
    const lines = Array.from({ length: 7 }, (_, i) => item(`l${i}`, 7n))
    expect(calculateDocumentTotals({ lines }).taxCents).toBe(9n)
  })

  it('creates one tax line per rate, highest rate first, with default categories', () => {
    const totals = calculateDocumentTotals({
      lines: [
        item('a', 10000n, { taxRatePercent: 7 }),
        item('b', 10000n),
        item('c', 5000n, { taxRatePercent: 0 }),
        item('d', 5000n, { taxRatePercent: 0, taxCategory: 'E' }),
      ],
    })
    expect(totals.taxLines.map((t) => [t.category, t.ratePercent, t.netCents, t.taxCents])).toEqual(
      [
        ['S', '19.00', 10000n, 1900n],
        ['S', '7.00', 10000n, 700n],
        ['E', '0.00', 5000n, 0n],
        ['Z', '0.00', 5000n, 0n],
      ],
    )
    expect(totals.taxLines[2]?.exemptionReason).toMatch(/§ 19 UStG/)
  })

  it('applies the document discount per tax group', () => {
    const totals = calculateDocumentTotals({
      lines: [item('a', 10001n), item('b', 20000n, { taxRatePercent: 7 })],
      discountPercent: '2,5',
    })
    expect(totals.discountCents).toBe(250n + 500n) // round(250,025) + 500
    expect(totals.netCents).toBe(30001n - 750n)
    expect(totals.taxLines[0]).toMatchObject({ netCents: 9751n, taxCents: 1853n })
    expect(totals.taxLines[1]).toMatchObject({ netCents: 19500n, taxCents: 1365n })
  })

  it('handles § 13b reverse charge: 0 %, category AE and the mandatory text', () => {
    const totals = calculateDocumentTotals({
      lines: [item('a', 431500n), item('b', 1000n, { taxRatePercent: 7 })],
      taxMode: 'reverse_charge_13b',
    })
    expect(totals.taxLines).toEqual([
      {
        category: 'AE',
        ratePercent: '0.00',
        netCents: 432500n,
        taxCents: 0n,
        exemptionReason: 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG).',
      },
    ])
    expect(totals.grossCents).toBe(432500n)
  })

  it.each([
    ['small_business', 'E'],
    ['intra_eu', 'K'],
    ['export', 'G'],
  ] as const)('maps tax mode %s to category %s', (taxMode, category) => {
    const totals = calculateDocumentTotals({ lines: [item('a', 100n)], taxMode })
    expect(totals.taxLines[0]).toMatchObject({ category, taxCents: 0n })
  })

  it('computes retention, construction levy, payable amount and cash discount', () => {
    const totals = calculateDocumentTotals({
      lines: [item('a', 100000n)],
      retentionPercent: 5,
      constructionLevyPercent: '0,5',
      cashDiscountPercent: 2,
    })
    expect(totals.grossCents).toBe(119000n)
    expect(totals.retentionCents).toBe(5950n)
    expect(totals.constructionLevyCents).toBe(595n)
    expect(totals.payableCents).toBe(112455n)
    expect(totals.cashDiscountCents).toBe(2249n)
  })

  it('reports the § 35a labor share net and including VAT after document discount', () => {
    const totals = calculateDocumentTotals({
      lines: [
        item('a', 100000n, { laborShareCents: 60000n }),
        item('b', 10000n, { taxRatePercent: 7, laborShareCents: 1000n }),
      ],
      discountPercent: 10,
    })
    expect(totals.laborShare).toEqual({ netCents: 54000n + 900n, grossCents: 64260n + 963n })
  })

  it('returns zeros for an empty document', () => {
    const totals = calculateDocumentTotals({ lines: [] })
    expect([totals.netCents, totals.taxCents, totals.grossCents, totals.payableCents]).toEqual([
      0n,
      0n,
      0n,
      0n,
    ])
    expect(totals.taxLines).toEqual([])
  })

  it('treats a missing total as zero', () => {
    expect(
      calculateDocumentTotals({ lines: [{ id: 'a', positionType: 'item', taxRatePercent: 19 }] })
        .netCents,
    ).toBe(0n)
  })

  it('validates input', () => {
    expect(() =>
      calculateDocumentTotals({ lines: [{ id: 'a', positionType: 'item', totalCents: 1n }] }),
    ).toThrow(/Steuersatz fehlt/)
    expect(() =>
      calculateDocumentTotals({ lines: [item('a', 1n, { parentId: 'missing' })] }),
    ).toThrow(/fehlt/)
    expect(() =>
      calculateDocumentTotals({
        lines: [
          { id: 'x', positionType: 'title', parentId: 'y' },
          { id: 'y', positionType: 'title', parentId: 'x' },
          item('a', 1n, { parentId: 'x' }),
        ],
      }),
    ).toThrow(/Zirkelbezug/)
    expect(() => calculateDocumentTotals({ lines: [], discountPercent: 120 })).toThrow(
      /Gesamtrabatt/,
    )
    expect(() => calculateDocumentTotals({ lines: [], retentionPercent: -1 })).toThrow(
      /Sicherheitseinbehalt/,
    )
  })

  it('adds items below a non-title parent only to enclosing titles', () => {
    const totals = calculateDocumentTotals({
      lines: [
        { id: 't', positionType: 'title' },
        { id: 'group', positionType: 'subtotal', parentId: 't' },
        item('a', 500n, { parentId: 'group' }),
      ],
    })
    expect(totals.titleSubtotals.get('t')).toBe(500n)
  })
})

describe('target price (Preis anpassen)', () => {
  const items = [
    { id: 'a', quantity: '51', unitPriceCents: 1431n, totalCents: 72981n, costCents: 62475n },
    { id: 'b', quantity: '1', unitPriceCents: 50000n, totalCents: 50000n, costCents: 40000n },
    { id: 'fixed', quantity: '1', unitPriceCents: 15000n, totalCents: 15000n, costCents: null },
  ]

  it('scales only the markup of calculated positions and keeps fixed ones', () => {
    const result = applyTargetPrice(items, 130000n)
    expect(result.items.find((i) => i.id === 'fixed')).toEqual({
      id: 'fixed',
      unitPriceCents: 15000n,
      totalCents: 15000n,
    })
    expect(result.netCents + result.residualCents).toBe(130000n)
    expect(result.residualCents < 51n && result.residualCents > -51n).toBe(true)
    expect(result.belowCost).toEqual([])
  })

  it('hits the target exactly when the largest position has quantity 1', () => {
    const result = applyTargetPrice(
      [
        { id: 'x', quantity: '1', unitPriceCents: 10000n, totalCents: 10000n, costCents: 8000n },
        { id: 'y', quantity: '3', unitPriceCents: 1000n, totalCents: 3000n, costCents: 2400n },
      ],
      12345n,
    )
    expect(result.netCents).toBe(12345n)
    expect(result.residualCents).toBe(0n)
  })

  it('warns when the target is below cost', () => {
    const result = applyTargetPrice(items, 100000n)
    expect(result.belowCost.length).toBeGreaterThan(0)
  })

  it('scales proportionally when there is no markup, or by cost when prices are zero', () => {
    const noMarkup = applyTargetPrice(
      [
        { id: 'x', quantity: '1', unitPriceCents: 1000n, totalCents: 1000n, costCents: 1000n },
        { id: 'y', quantity: '1', unitPriceCents: 3000n, totalCents: 3000n, costCents: 3000n },
      ],
      8000n,
    )
    expect(noMarkup.items.map((i) => i.totalCents)).toEqual([2000n, 6000n])
    const zeroPrices = applyTargetPrice(
      [
        { id: 'x', quantity: '1', unitPriceCents: 0n, totalCents: 0n, costCents: 0n },
        { id: 'y', quantity: '1', unitPriceCents: 0n, totalCents: 0n, costCents: 0n },
      ],
      1000n,
    )
    expect(zeroPrices.netCents).toBe(1000n)
  })

  it('distributes by cost when prices are zero but costs exist', () => {
    const result = applyTargetPrice(
      [
        { id: 'x', quantity: '1', unitPriceCents: 0n, totalCents: 0n, costCents: 100n },
        { id: 'y', quantity: '1', unitPriceCents: 0n, totalCents: 0n, costCents: 300n },
      ],
      800n,
    )
    expect(result.items.map((i) => i.totalCents)).toEqual([200n, 600n])
  })

  it('skips locked positions and positions with zero quantity', () => {
    const result = applyTargetPrice(
      [
        {
          id: 'x',
          quantity: '1',
          unitPriceCents: 1000n,
          totalCents: 1000n,
          costCents: 500n,
          locked: true,
        },
        { id: 'z', quantity: '0', unitPriceCents: 1000n, totalCents: 0n, costCents: 0n },
        { id: 'y', quantity: '2', unitPriceCents: 1000n, totalCents: 2000n, costCents: 1000n },
      ],
      4000n,
    )
    expect(result.items.map((i) => i.totalCents)).toEqual([1000n, 0n, 3000n])
  })

  it('keeps an unavoidable rounding residual visible', () => {
    // Only a position with quantity 3 can change: totals are multiples of 3 cents.
    const result = applyTargetPrice(
      [{ id: 'x', quantity: '3', unitPriceCents: 100n, totalCents: 300n, costCents: 150n }],
      400n,
    )
    expect(result.netCents).toBe(399n)
    expect(result.residualCents).toBe(1n)
  })

  it('does not push the largest position below zero when correcting the remainder', () => {
    const result = applyTargetPrice(
      ['x', 'y', 'z'].map((id) => ({
        id,
        quantity: '10',
        unitPriceCents: 100n,
        totalCents: 1000n,
        costCents: 0n,
      })),
      15n,
    )
    expect(result.items.every((i) => i.unitPriceCents >= 0n)).toBe(true)
    expect(result.netCents).toBe(30n)
    expect(result.residualCents).toBe(-15n)
  })

  it('validates input', () => {
    expect(() => applyTargetPrice(items, -1n)).toThrow(/negativ/)
    expect(() => applyTargetPrice([items[2] as (typeof items)[number]], 1000n)).toThrow(
      /Keine kalkulierten/,
    )
    expect(() =>
      applyTargetPrice(
        [
          { id: 'x', quantity: '1', unitPriceCents: 1000n, totalCents: 1000n, costCents: 900n },
          { id: 'f', quantity: '1', unitPriceCents: 5000n, totalCents: 5000n, costCents: null },
        ],
        1000n,
      ),
    ).toThrow(/negativ/)
  })

  it('offers a separate adjustment line instead of redistribution', () => {
    expect(targetPriceAdjustmentLine(137981n, 130000n)).toBe(-7981n)
  })
})
