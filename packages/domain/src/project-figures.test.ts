import { describe, expect, it } from 'vitest'
import { projectCosts, projectFigures, sumHours } from './project-figures.js'

const invoice = (net: bigint, open = 0n, paid = 0n) => ({
  type: 'invoice' as const,
  netCents: net,
  grossCents: (net * 119n) / 100n,
  openCents: open,
  paidCents: paid,
})

describe('projectFigures (Projektkennzahlen)', () => {
  it('sums billed, paid and open and compares with the Vertragssumme', () => {
    const figures = projectFigures({
      contractNetCents: 1_000_000n,
      plannedHours: ['12.5', '30', '0.25'],
      uncalculatedCount: 2,
      documents: [
        invoice(300_000n, 0n, 357_000n),
        invoice(200_000n, 238_000n),
        {
          type: 'credit_note',
          netCents: 10_000n,
          grossCents: 11_900n,
          openCents: 0n,
          paidCents: 0n,
        },
      ],
    })
    expect(figures).toEqual({
      plannedHours: '42.75',
      uncalculatedCount: 2,
      contractNetCents: 1_000_000n,
      billedNetCents: 490_000n,
      billedGrossCents: 583_100n,
      paidCents: 357_000n,
      openReceivableCents: 238_000n,
      unbilledNetCents: 510_000n,
      overbilledNetCents: 0n,
      billedPercent: '49.0',
    })
  })

  it('shows billing beyond the contract separately', () => {
    const figures = projectFigures({
      contractNetCents: 100_000n,
      plannedHours: [],
      uncalculatedCount: 0,
      documents: [invoice(112_345n)],
    })
    expect(figures).toMatchObject({
      unbilledNetCents: 0n,
      overbilledNetCents: 12_345n,
      billedPercent: '112.3',
      plannedHours: '0',
    })
  })

  it('has no rest and no percentage without contract', () => {
    expect(
      projectFigures({
        contractNetCents: null,
        plannedHours: ['1'],
        uncalculatedCount: 0,
        documents: [],
      }),
    ).toMatchObject({ unbilledNetCents: null, overbilledNetCents: 0n, billedPercent: null })
    expect(
      projectFigures({
        contractNetCents: 0n,
        plannedHours: [],
        uncalculatedCount: 0,
        documents: [],
      }).billedPercent,
    ).toBeNull()
  })

  it('rounds hours to two decimals', () => {
    expect(sumHours(['0.125', '0.004'])).toBe('0.13')
    expect(sumHours(['8.5'])).toBe('8.5')
  })
})

describe('Projektkosten aus Eingangsrechnungen', () => {
  it('sums allocations by cost type, credit notes reduce', () => {
    expect(
      projectCosts(
        [
          { costType: 'material', netCents: 100_000n, creditNote: false },
          { costType: 'material', netCents: 20_000n, creditNote: true },
          { costType: 'subcontract', netCents: 50_000n, creditNote: false },
        ],
        300_000n,
      ),
    ).toEqual({
      totalCents: 130_000n,
      byType: { material: 80_000n, labor: 0n, equipment: 0n, subcontract: 50_000n, other: 0n },
      contributionCents: 170_000n,
    })
    expect(projectCosts([], 0n).totalCents).toBe(0n)
  })
})
