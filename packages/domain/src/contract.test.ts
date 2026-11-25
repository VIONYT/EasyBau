import { describe, expect, it } from 'vitest'
import { acceptedPart, contractTotals, quantityDeviation } from './contract.js'

describe('contractTotals (Vertragssumme)', () => {
  it('is the main contract plus accepted change orders only', () => {
    const totals = contractTotals(1_000_000n, [
      { status: 'accepted', netCents: 120_000n, acceptedNetCents: 0n },
      { status: 'partially_accepted', netCents: 80_000n, acceptedNetCents: 50_000n },
      { status: 'offered', netCents: 40_000n, acceptedNetCents: 0n },
      { status: 'draft', netCents: 10_000n, acceptedNetCents: 0n },
      { status: 'rejected', netCents: 25_000n, acceptedNetCents: 0n },
    ])
    expect(totals).toEqual({
      contractNetCents: 1_000_000n,
      acceptedNetCents: 170_000n,
      offeredNetCents: 40_000n,
      draftNetCents: 10_000n,
      rejectedNetCents: 55_000n,
      totalNetCents: 1_170_000n,
      potentialNetCents: 1_210_000n,
    })
  })

  it('works without a main contract and without change orders', () => {
    expect(contractTotals(null, [])).toMatchObject({ contractNetCents: 0n, totalNetCents: 0n })
  })

  it('handles Mindermengen (negative change orders)', () => {
    const totals = contractTotals(500_000n, [
      { status: 'accepted', netCents: -30_000n, acceptedNetCents: 0n },
    ])
    expect(totals.totalNetCents).toBe(470_000n)
  })

  it('counts only the accepted part of a change order', () => {
    expect(acceptedPart({ status: 'offered', netCents: 1n, acceptedNetCents: 1n })).toBe(0n)
    expect(acceptedPart({ status: 'accepted', netCents: 5n, acceptedNetCents: 0n })).toBe(5n)
    expect(acceptedPart({ status: 'partially_accepted', netCents: 5n, acceptedNetCents: 2n })).toBe(
      2n,
    )
  })
})

describe('quantityDeviation (VOB/B § 2 Abs. 3)', () => {
  it('flags more than 110 % and less than 90 % of the ordered quantity', () => {
    expect(quantityDeviation('100', '110')).toEqual({ percent: '110', rule: null })
    expect(quantityDeviation('100', '110,5'.replace(',', '.'))).toEqual({
      percent: '111',
      rule: 'over_110',
    })
    expect(quantityDeviation('100', '90')).toEqual({ percent: '90', rule: null })
    expect(quantityDeviation('100', '89.9')).toEqual({ percent: '90', rule: 'under_90' })
    expect(quantityDeviation('40', '0')).toEqual({ percent: '0', rule: 'under_90' })
  })

  it('has no ratio without an ordered quantity', () => {
    expect(quantityDeviation('0', '5')).toEqual({ percent: null, rule: null })
  })
})
