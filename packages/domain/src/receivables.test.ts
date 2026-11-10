import { describe, expect, it } from 'vitest'
import { giroCodePayload } from './girocode.js'
import { type ReceivableInput, receivableState, settlementSuggestion } from './receivables.js'

const base: ReceivableInput = {
  grossCents: 119_000n,
  paidCents: 0n,
  adjustments: [],
  dueDate: '2026-11-24',
  today: '2026-11-10',
  cancelled: false,
  dunned: false,
}

describe('Offene Forderung und Status', () => {
  it('is open until the due date, then overdue', () => {
    expect(receivableState(base)).toEqual({
      status: 'open',
      openCents: 119_000n,
      creditCents: 0n,
      adjustedCents: 0n,
      retentionHeldCents: 0n,
      overdueDays: 0,
    })
    expect(receivableState({ ...base, today: '2026-11-24' }).status).toBe('open')
    expect(receivableState({ ...base, today: '2026-12-01' })).toMatchObject({
      status: 'overdue',
      overdueDays: 7,
    })
    expect(receivableState({ ...base, dueDate: null, today: '2027-01-01' }).status).toBe('open')
  })

  it('counts partial payments and deductions', () => {
    const partial = receivableState({ ...base, paidCents: 50_000n })
    expect(partial).toMatchObject({ status: 'partially_paid', openCents: 69_000n })
    const shortPaid = receivableState({
      ...base,
      adjustments: [{ kind: 'short_payment', amountCents: 9_000n }],
    })
    expect(shortPaid).toMatchObject({
      status: 'partially_paid',
      openCents: 110_000n,
      adjustedCents: 9_000n,
    })
    expect(receivableState({ ...base, paidCents: 50_000n, today: '2026-12-24' })).toMatchObject({
      status: 'overdue',
      overdueDays: 30,
    })
  })

  it('is paid when payments and deductions cover the gross amount; overpayment is a credit', () => {
    const settled = receivableState({
      ...base,
      paidCents: 107_100n,
      adjustments: [
        { kind: 'retention', amountCents: 5_950n },
        { kind: 'cash_discount', amountCents: 5_950n },
      ],
      today: '2027-03-01',
    })
    expect(settled).toMatchObject({
      status: 'paid',
      openCents: 0n,
      retentionHeldCents: 5_950n,
      overdueDays: 0,
    })
    expect(receivableState({ ...base, paidCents: 120_000n })).toMatchObject({
      status: 'paid',
      openCents: 0n,
      creditCents: 1_000n,
    })
    // Retention paid out later: payment plus negative retention deduction.
    expect(
      receivableState({
        ...base,
        paidCents: 113_050n,
        adjustments: [
          { kind: 'retention', amountCents: 5_950n },
          { kind: 'retention', amountCents: -5_950n },
          { kind: 'cash_discount', amountCents: 5_950n },
        ],
      }),
    ).toMatchObject({ status: 'paid', retentionHeldCents: 0n })
  })

  it('marks dunned and cancelled invoices', () => {
    expect(receivableState({ ...base, dunned: true, today: '2026-12-10' }).status).toBe('dunned')
    expect(receivableState({ ...base, dunned: true, paidCents: 119_000n }).status).toBe('paid')
    expect(receivableState({ ...base, cancelled: true, paidCents: 10_000n })).toMatchObject({
      status: 'cancelled',
      openCents: 0n,
      creditCents: 0n,
    })
  })
})

describe('Vorschlag beim Zahlungseingang', () => {
  // 1.000 € netto + 19 % = 1.190 €; 5 % Einbehalt = 59,50 €, 0,5 % Bauumlage = 5,95 €;
  // Zahlbetrag 1.124,55 €; 2 % Skonto darauf = 22,49 € (bis 14 Tage nach Rechnungsdatum).
  const invoice = {
    openCents: 119_000n,
    documentDate: '2026-11-01',
    cashDiscountPercent: '2',
    cashDiscountDays: 14,
    payableCents: 112_455n,
    retentionCents: 5_950n,
    constructionLevyCents: 595n,
    adjustments: [],
  }

  it('settles retention, construction levy and Skonto within the period', () => {
    expect(
      settlementSuggestion({ ...invoice, amountCents: 110_206n, paidOn: '2026-11-15' }),
    ).toEqual([
      { kind: 'retention', amountCents: 5_950n },
      { kind: 'construction_levy', amountCents: 595n },
      { kind: 'cash_discount', amountCents: 2_249n },
    ])
  })

  it('suggests only retention and levy when the full Zahlbetrag is paid', () => {
    expect(
      settlementSuggestion({ ...invoice, amountCents: 112_455n, paidOn: '2026-11-30' }),
    ).toEqual([
      { kind: 'retention', amountCents: 5_950n },
      { kind: 'construction_levy', amountCents: 595n },
    ])
  })

  it('treats a late Skonto or any other difference as a partial payment', () => {
    expect(
      settlementSuggestion({ ...invoice, amountCents: 110_206n, paidOn: '2026-11-16' }),
    ).toEqual([])
    expect(
      settlementSuggestion({ ...invoice, amountCents: 50_000n, paidOn: '2026-11-05' }),
    ).toEqual([])
    expect(
      settlementSuggestion({ ...invoice, amountCents: 119_000n, paidOn: '2026-11-05' }),
    ).toEqual([])
    expect(
      settlementSuggestion({
        ...invoice,
        cashDiscountPercent: null,
        cashDiscountDays: null,
        amountCents: 110_206n,
        paidOn: '2026-11-05',
      }),
    ).toEqual([])
  })

  it('does not suggest deductions twice', () => {
    expect(
      settlementSuggestion({
        ...invoice,
        openCents: 2_249n,
        adjustments: [
          { kind: 'retention', amountCents: 5_950n },
          { kind: 'construction_levy', amountCents: 595n },
        ],
        amountCents: 0n,
        paidOn: '2026-11-10',
      }),
    ).toEqual([{ kind: 'cash_discount', amountCents: 2_249n }])
    expect(
      settlementSuggestion({
        ...invoice,
        openCents: 2_249n,
        adjustments: [{ kind: 'cash_discount', amountCents: 1_000n }],
        retentionCents: 0n,
        constructionLevyCents: 0n,
        amountCents: 0n,
        paidOn: '2026-11-10',
      }),
    ).toEqual([])
  })
})

describe('GiroCode (EPC-QR)', () => {
  it('encodes recipient, IBAN, amount and invoice number', () => {
    expect(
      giroCodePayload({
        name: 'Muster  Bau GmbH',
        iban: 'DE89 3704 0044 0532 0130 00',
        bic: 'cobadeffxxx',
        amountCents: 112_455n,
        reference: 'R-00101',
      }),
    ).toBe(
      'BCD\n002\n1\nSCT\nCOBADEFFXXX\nMuster Bau GmbH\nDE89370400440532013000\nEUR1124.55\n\n\nR-00101',
    )
    expect(
      giroCodePayload({
        name: 'A',
        iban: 'DE89370400440532013000',
        amountCents: 5n,
        reference: 'x',
      }),
    ).toContain('\n\nA\nDE89370400440532013000\nEUR0.05')
  })

  it('makes no code without valid IBAN, name or amount', () => {
    const ok = { name: 'Firma', iban: 'DE89370400440532013000', amountCents: 100n, reference: 'R' }
    expect(giroCodePayload({ ...ok, iban: null })).toBeNull()
    expect(giroCodePayload({ ...ok, iban: 'keine IBAN' })).toBeNull()
    expect(giroCodePayload({ ...ok, amountCents: 0n })).toBeNull()
    expect(giroCodePayload({ ...ok, amountCents: 100_000_000_000n })).toBeNull()
    expect(giroCodePayload({ ...ok, name: '  ' })).toBeNull()
  })
})
