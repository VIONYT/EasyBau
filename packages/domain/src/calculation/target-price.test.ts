import { describe, expect, it } from 'vitest'
import { Decimal } from '../decimal.js'
import { scaleMarkupPercent, targetPriceRatios } from './target-price.js'

describe('Zielpreis über Zuschläge', () => {
  const items = [
    { id: 'a', quantity: '10', unitPriceCents: 1200n, totalCents: 12_000n, costCents: 10_000n },
    { id: 'b', quantity: '1', unitPriceCents: 6000n, totalCents: 6000n, costCents: 4000n },
    { id: 'fix', quantity: '1', unitPriceCents: 2000n, totalCents: 2000n, costCents: null },
  ]

  it('scales only the markup part to reach the target', () => {
    // Markup 2000 + 2000 = 4000; target 18 000 − fixed 2000 = 16 000 → k = (16 000 − 14 000) / 4000 = 0,5
    const { ratios, belowCost } = targetPriceRatios(items, 18_000n)
    expect(ratios.get('a')?.toFixed(6)).toBe('0.916667')
    expect(ratios.get('b')?.toFixed(6)).toBe('0.833333')
    expect(ratios.has('fix')).toBe(false)
    expect(belowCost).toEqual([])
    // Locked positions stay fixed too; below cost is reported
    const locked = targetPriceRatios(
      items.map((i) => (i.id === 'b' ? { ...i, locked: true } : i)),
      9000n,
    )
    expect(locked.ratios.get('a')?.toFixed(6)).toBe('0.083333')
    expect(locked.belowCost).toEqual(['a'])
  })

  it('scales proportionally without any markup', () => {
    const flat = [
      { id: 'a', quantity: '1', unitPriceCents: 1000n, totalCents: 1000n, costCents: 1000n },
      { id: 'b', quantity: '1', unitPriceCents: 3000n, totalCents: 3000n, costCents: 3000n },
    ]
    const { ratios, belowCost } = targetPriceRatios(flat, 5000n)
    expect(ratios.get('a')?.toString()).toBe('1.25')
    expect(ratios.get('b')?.toString()).toBe('1.25')
    expect(belowCost).toEqual([])
  })

  it('rejects impossible targets', () => {
    expect(() => targetPriceRatios(items, -1n)).toThrow(/negativ/)
    expect(() => targetPriceRatios([items[2] as never], 100n)).toThrow(/Keine kalkulierten/)
    expect(() => targetPriceRatios(items, 2000n)).toThrow(/zu niedrig/)
  })

  it('converts a ratio into the new markup of a cost line', () => {
    expect(scaleMarkupPercent('20', new Decimal('0.95'))).toBe('14.0000')
    expect(scaleMarkupPercent('0', new Decimal('1.1'))).toBe('10.0000')
    expect(scaleMarkupPercent('15', new Decimal(1).div(3))).toBe('-61.6667')
    expect(() => scaleMarkupPercent('0', new Decimal(0))).toThrow(/zu niedrig/)
    expect(() => scaleMarkupPercent('100', new Decimal(6))).toThrow(/999 %/)
  })
})
