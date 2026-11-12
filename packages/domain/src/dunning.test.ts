import { describe, expect, it } from 'vitest'
import {
  baseRateOn,
  defaultInterest,
  dunningAmounts,
  LATE_PAYMENT_FLAT_FEE_CENTS,
  nextDunningDue,
  nextDunningLevel,
} from './dunning.js'

const rates = [
  { validFrom: '2026-07-01', ratePercent: '1.52' },
  { validFrom: '2025-07-01', ratePercent: '1.27' },
  { validFrom: '2026-01-01', ratePercent: '1.27' },
  { validFrom: '2016-07-01', ratePercent: '-0.88' },
]

describe('dunning levels', () => {
  it('follow each other', () => {
    expect(nextDunningLevel([])).toBe('reminder')
    expect(nextDunningLevel(['reminder'])).toBe('first')
    expect(nextDunningLevel(['reminder', 'first'])).toBe('final')
    expect(nextDunningLevel(['reminder', 'first', 'final'])).toBeNull()
  })
})

describe('Verzugszinsen (§ 288 BGB)', () => {
  it('picks the base rate in force', () => {
    expect(baseRateOn('2026-06-30', rates).ratePercent).toBe('1.27')
    expect(baseRateOn('2026-07-01', rates).ratePercent).toBe('1.52')
    expect(() => baseRateOn('2010-01-01', rates)).toThrow('Kein Basiszinssatz')
  })

  it('computes to the day for businesses (base rate + 9 points)', () => {
    // 1.000,00 € × 10,27 % × 30/365 = 8,4411 € → 8,44 €
    const result = defaultInterest({
      principalCents: 100_000n,
      from: '2026-06-01',
      to: '2026-06-30',
      baseRates: rates,
      points: 9,
    })
    expect(result.cents).toBe(844n)
    expect(result.segments).toEqual([
      {
        from: '2026-06-01',
        to: '2026-06-30',
        days: 30,
        ratePercent: '10.27',
        principalCents: 100_000n,
      },
    ])
  })

  it('splits periods where the base rate changes (consumer: + 5 points)', () => {
    // 1.000,00 € × (6,27 % × 10 + 6,52 % × 10) / 365 = 3,504 € → 3,50 €
    const result = defaultInterest({
      principalCents: 100_000n,
      from: '2026-06-21',
      to: '2026-07-10',
      baseRates: rates,
      points: 5,
    })
    expect(result.cents).toBe(350n)
    expect(result.segments.map((s) => [s.from, s.to, s.days, s.ratePercent])).toEqual([
      ['2026-06-21', '2026-06-30', 10, '6.27'],
      ['2026-07-01', '2026-07-10', 10, '6.52'],
    ])
  })

  it('lowers the principal from the day after a payment and merges unchanged rates', () => {
    // 1.000 € from 25.12.2025 to 05.01.2026 (12 days, base rate 1,27 % both years),
    // 400 € paid on 31.12.: 1.000 € × 10,27 % × 7/365 + 600 € × 10,27 % × 5/365 = 2,8137 € → 2,81 €
    const result = defaultInterest({
      principalCents: 100_000n,
      from: '2025-12-25',
      to: '2026-01-05',
      baseRates: rates,
      points: 9,
      payments: [
        { date: '2025-12-31', amountCents: 40_000n },
        { date: '2025-12-01', amountCents: 5n },
        { date: '2026-01-05', amountCents: 5n },
      ],
    })
    expect(result.segments.map((s) => [s.from, s.to, s.days, s.principalCents])).toEqual([
      ['2025-12-25', '2025-12-31', 7, 100_000n],
      ['2026-01-01', '2026-01-05', 5, 60_000n],
    ])
    expect(result.cents).toBe(281n)
    const unchanged = defaultInterest({
      principalCents: 100_000n,
      from: '2025-12-20',
      to: '2026-01-10',
      baseRates: rates,
      points: 9,
    })
    expect(unchanged.segments.map((s) => [s.from, s.to, s.days])).toEqual([
      ['2025-12-20', '2026-01-10', 22],
    ])
    // Fully paid in between: no interest afterwards.
    const paid = defaultInterest({
      principalCents: 100_000n,
      from: '2026-06-01',
      to: '2026-06-30',
      baseRates: rates,
      points: 9,
      payments: [{ date: '2026-06-10', amountCents: 100_000n }],
    })
    expect(paid.segments).toEqual([
      {
        from: '2026-06-01',
        to: '2026-06-10',
        days: 10,
        ratePercent: '10.27',
        principalCents: 100_000n,
      },
    ])
  })

  it('yields nothing without principal, period or positive rate', () => {
    const none = { cents: 0n, segments: [] }
    expect(
      defaultInterest({
        principalCents: 0n,
        from: '2026-01-01',
        to: '2026-02-01',
        baseRates: rates,
        points: 9,
      }),
    ).toEqual(none)
    expect(
      defaultInterest({
        principalCents: 100n,
        from: '2026-02-02',
        to: '2026-02-01',
        baseRates: rates,
        points: 9,
      }),
    ).toEqual(none)
    expect(
      defaultInterest({
        principalCents: 100_000n,
        from: '2020-01-01',
        to: '2020-12-31',
        baseRates: rates,
        points: 0,
      }).cents,
    ).toBe(0n)
  })
})

describe('dunning amounts', () => {
  const base = {
    level: 'first' as const,
    noticeDate: '2026-06-30',
    openCents: 100_000n,
    business: true,
    rule: { days: 7, feeCents: 500n, interest: true },
    interestFrom: '2026-06-01',
    baseRates: rates,
    flatFee: true,
    earlierChargesCents: 0n,
    flatFeeCharged: false,
  }

  it('adds fee, Pauschale and interest to the open amount', () => {
    expect(dunningAmounts(base)).toEqual({
      dueDate: '2026-07-07',
      feeCents: 500n,
      flatFeeCents: LATE_PAYMENT_FLAT_FEE_CENTS,
      interestCents: 844n,
      interestRatePercent: '10.27',
      interestFrom: '2026-06-01',
      interestTo: '2026-06-30',
      segments: [
        {
          from: '2026-06-01',
          to: '2026-06-30',
          days: 30,
          ratePercent: '10.27',
          principalCents: 100_000n,
        },
      ],
      earlierChargesCents: 0n,
      totalCents: 100_000n + 500n + 4000n + 844n,
    })
  })

  it('charges the Pauschale once and only to businesses; consumers get 5 points', () => {
    const again = dunningAmounts({ ...base, flatFeeCharged: true, earlierChargesCents: 4500n })
    expect(again.flatFeeCents).toBe(0n)
    expect(again.totalCents).toBe(100_000n + 4500n + 500n + 844n)
    const consumer = dunningAmounts({ ...base, business: false })
    expect(consumer.flatFeeCents).toBe(0n)
    expect(consumer.interestRatePercent).toBe('6.27')
  })

  it('has no interest without start date, when switched off or before the start', () => {
    const reminder = dunningAmounts({
      ...base,
      level: 'reminder',
      rule: { days: 10, feeCents: 0n, interest: false },
      flatFee: false,
    })
    expect(reminder).toMatchObject({
      dueDate: '2026-07-10',
      interestCents: 0n,
      interestRatePercent: '0.00',
      interestFrom: null,
      interestTo: null,
      totalCents: 100_000n,
    })
    expect(dunningAmounts({ ...base, interestFrom: null }).interestCents).toBe(0n)
    // Paid 200 € on 10.06.: interest on 1.200 € until then.
    const partly = dunningAmounts({
      ...base,
      paymentsSinceInterestFrom: [{ date: '2026-06-10', amountCents: 20_000n }],
    })
    expect(partly.segments.map((seg) => seg.principalCents)).toEqual([120_000n, 100_000n])
    const early = dunningAmounts({ ...base, interestFrom: '2026-07-05' })
    expect(early).toMatchObject({ interestCents: 0n, interestFrom: null, interestTo: null })
  })
})

describe('Mahnvorschlag: nächste fällige Mahnstufe', () => {
  const base = {
    eligible: true,
    openCents: 119_000n,
    dueDate: '2026-11-16',
    notices: [] as { level: 'reminder' | 'first' | 'final'; dueDate: string }[],
    today: '2026-11-17',
  }

  it('suggests the Zahlungserinnerung the day after the due date', () => {
    expect(nextDunningDue(base)).toEqual({
      level: 'reminder',
      possibleFrom: '2026-11-17',
      due: true,
    })
    expect(nextDunningDue({ ...base, today: '2026-11-16' })).toEqual({
      level: 'reminder',
      possibleFrom: '2026-11-17',
      due: false,
    })
  })

  it('waits for the deadline of the last notice', () => {
    const notices = [{ level: 'reminder' as const, dueDate: '2026-11-24' }]
    expect(nextDunningDue({ ...base, notices, today: '2026-11-24' })).toEqual({
      level: 'first',
      possibleFrom: '2026-11-25',
      due: false,
    })
    expect(nextDunningDue({ ...base, notices, today: '2026-11-25' })?.due).toBe(true)
  })

  it('has nothing to suggest for paid, cancelled or fully dunned invoices', () => {
    expect(nextDunningDue({ ...base, openCents: 0n })).toBeNull()
    expect(nextDunningDue({ ...base, eligible: false })).toBeNull()
    expect(
      nextDunningDue({
        ...base,
        notices: [
          { level: 'reminder', dueDate: '2026-11-24' },
          { level: 'first', dueDate: '2026-12-01' },
          { level: 'final', dueDate: '2026-12-08' },
        ],
      }),
    ).toBeNull()
  })
})
