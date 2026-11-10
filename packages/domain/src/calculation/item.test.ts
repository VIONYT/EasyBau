import { describe, expect, it } from 'vitest'
import {
  CalculationError,
  calculateItem,
  hourlyRateCents,
  priceItem,
  rateForTimeUnit,
} from './item.js'
import { packDemand } from './packs.js'

describe('position calculation: unit price mode', () => {
  it('reproduces the construction fence example (Bauzaun, 51 Lfm)', () => {
    // Per Lfm: equipment 1 psch × 10,00 € and labor 3 min × 0,75 €/min = 12,25 € cost;
    // surcharges: equipment 15 %, labor 25 %  → 11,50 + 2,8125 = 14,3125 € → EP 14,31 €
    const result = calculateItem({
      quantity: '51',
      costLines: [
        { kind: 'equipment', quantity: 1, unit: 'psch', unitCostCents: 1000 },
        { kind: 'labor', quantity: 3, unit: 'min', unitCostCents: 75 },
      ],
      surcharges: { equipment: 15, labor: 25 },
    })
    expect(result.unitPriceCents).toBe(1431n)
    expect(result.grossLineCents).toBe(72981n) // 51 × 14,31 €
    expect(result.totalCents).toBe(72981n)
    expect(result.costCents).toBe(62475n) // 51 × 12,25 €
    expect(result.marginCents).toBe(72981n - 62475n)
    expect(result.marginPercent).toBe('14.40')
    expect(result.laborHours).toBe('2.5500') // 51 × 3 min
    expect(result.byKind.labor).toEqual({ costCents: '11475.0000', sellCents: '14343.7500' })
    expect(result.byKind.material).toEqual({ costCents: '0.0000', sellCents: '0.0000' })
  })

  it('uses the per-line markup over the default surcharge', () => {
    const result = calculateItem({
      quantity: 1,
      costLines: [{ kind: 'material', quantity: 1, unitCostCents: 1000, markupPercent: 50 }],
      surcharges: { material: 10 },
    })
    expect(result.unitPriceCents).toBe(1500n)
  })

  it('applies a line discount after rounding the line total', () => {
    const result = calculateItem({
      quantity: '12,5',
      costLines: [{ kind: 'material', quantity: 1, unitCostCents: 3333 }],
      discountPercent: 10,
    })
    expect(result.grossLineCents).toBe(41663n) // 12,5 × 33,33 € = 416,625 → 416,63 €
    expect(result.discountCents).toBe(4166n)
    expect(result.totalCents).toBe(37497n)
  })

  it('counts labor in hours; unknown units count as hours', () => {
    const result = calculateItem({
      quantity: 2,
      costLines: [
        { kind: 'labor', quantity: '1,5', unit: 'Std', unitCostCents: 4500 },
        { kind: 'labor', quantity: 1, unitCostCents: 4500 },
      ],
    })
    expect(result.laborHours).toBe('5.0000')
    expect(result.laborShareCents).toBe(result.totalCents)
  })

  it('handles positions without cost lines and zero quantity', () => {
    const empty = calculateItem({ quantity: 0, costLines: [] })
    expect(empty).toMatchObject({
      unitPriceCents: 0n,
      totalCents: 0n,
      marginPercent: null,
      laborShareCents: 0n,
    })
  })

  it('splits the labor share proportionally to the rounded price', () => {
    const result = calculateItem({
      quantity: 1,
      costLines: [
        { kind: 'labor', quantity: 1, unit: 'Std', unitCostCents: 6000 },
        { kind: 'material', quantity: 1, unitCostCents: 4000 },
      ],
      discountPercent: 50,
    })
    expect(result.totalCents).toBe(5000n)
    expect(result.laborShareCents).toBe(3000n)
  })
})

describe('position calculation: total price mode', () => {
  it('derives the unit price from the position total', () => {
    // Cost lines describe the whole position: 2 Std × 50 € + material 33,33 € = 133,33 €
    const result = calculateItem({
      quantity: 3,
      calcMode: 'total_price',
      costLines: [
        { kind: 'labor', quantity: 2, unit: 'Std', unitCostCents: 5000 },
        { kind: 'material', quantity: 1, unitCostCents: 3333 },
      ],
    })
    expect(result.grossLineCents).toBe(13333n)
    expect(result.unitPriceCents).toBe(4444n) // 133,33 / 3 = 44,443…
    expect(result.laborHours).toBe('2.0000') // not multiplied by the quantity
  })

  it('requires a quantity greater than zero', () => {
    expect(() =>
      calculateItem({
        quantity: 0,
        calcMode: 'total_price',
        costLines: [{ kind: 'other', quantity: 1, unitCostCents: 1 }],
      }),
    ).toThrow(CalculationError)
  })

  it('allows an empty total-price position with zero quantity', () => {
    expect(
      calculateItem({ quantity: 0, calcMode: 'total_price', costLines: [] }).unitPriceCents,
    ).toBe(0n)
  })
})

describe('position calculation: validation', () => {
  it('rejects negative costs, impossible markups and discounts', () => {
    expect(() =>
      calculateItem({
        quantity: 1,
        costLines: [{ kind: 'material', quantity: -1, unitCostCents: 100 }],
      }),
    ).toThrow(/negativ/)
    expect(() =>
      calculateItem({
        quantity: 1,
        costLines: [{ kind: 'material', quantity: 1, unitCostCents: 100, markupPercent: -100 }],
      }),
    ).toThrow(/100 %/)
    expect(() => calculateItem({ quantity: 1, costLines: [], discountPercent: 101 })).toThrow(
      /Rabatt/,
    )
    expect(() => calculateItem({ quantity: 1, costLines: [], discountPercent: -1 })).toThrow(
      /Rabatt/,
    )
  })
})

describe('direct pricing and rates', () => {
  it('prices a position without calculation', () => {
    expect(priceItem({ quantity: '12,5', unitPriceCents: 4500 })).toEqual({
      unitPriceCents: 4500n,
      grossLineCents: 56250n,
      discountCents: 0n,
      totalCents: 56250n,
    })
    expect(priceItem({ quantity: 1, unitPriceCents: '999', discountPercent: '3' }).totalCents).toBe(
      969n,
    )
    expect(() => priceItem({ quantity: 1, unitPriceCents: 1, discountPercent: 200 })).toThrow(
      /Rabatt/,
    )
    expect(() => priceItem({ quantity: 1, unitPriceCents: 1, discountPercent: -5 })).toThrow(
      /Rabatt/,
    )
  })

  it('computes the hourly rate of a wage group (Auszubildender 2. Lehrjahr)', () => {
    expect(hourlyRateCents(3420, '19,01')).toBe(4070n) // 34,20 € × 1,1901 = 40,70 €
    expect(hourlyRateCents(4500)).toBe(4500n)
  })

  it('converts an hourly rate to other time units', () => {
    expect(rateForTimeUnit(4500, 'min').toString()).toBe('75')
    expect(rateForTimeUnit(4500, 'Std').toString()).toBe('4500')
  })
})

describe('material packs (Gebinde)', () => {
  it('rounds up to whole packs by default', () => {
    // 4 kg/m² × 37,5 m² = 150 kg; 25-kg sacks → 6 sacks, no surplus
    expect(packDemand({ consumptionPerUnit: 4, quantity: '37,5', packSize: 25 })).toEqual({
      demand: '150.0000',
      packs: '6.0000',
      surplus: '0.0000',
    })
    expect(packDemand({ consumptionPerUnit: '0,3', quantity: 40, packSize: '12,5' })).toEqual({
      demand: '12.0000',
      packs: '1.0000',
      surplus: '0.5000',
    })
  })

  it('can skip rounding', () => {
    expect(
      packDemand({ consumptionPerUnit: 1, quantity: 30, packSize: 25, roundUpToWholePacks: false })
        .packs,
    ).toBe('1.2000')
  })

  it('validates inputs', () => {
    expect(() => packDemand({ consumptionPerUnit: 1, quantity: 1, packSize: 0 })).toThrow(
      /Gebindeinhalt/,
    )
    expect(() => packDemand({ consumptionPerUnit: -1, quantity: 1, packSize: 1 })).toThrow(
      /negativ/,
    )
  })
})
