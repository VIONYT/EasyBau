import { describe, expect, it } from 'vitest'
import {
  allocationTax,
  distributeAllowanceCharges,
  type IncomingAllocation,
  type IncomingCheckInput,
  incomingProblems,
  incomingWarnings,
  rateKey,
} from './incoming.js'

const allocation = (over: Partial<IncomingAllocation> = {}): IncomingAllocation => ({
  projectId: 'p1',
  businessAreaId: null,
  costType: 'material',
  ratePercent: '19',
  netCents: 10000n,
  ...over,
})

const valid = (over: Partial<IncomingCheckInput> = {}): IncomingCheckInput => ({
  supplierName: 'Baustoff Nord GmbH',
  invoiceNumber: 'RE-4711',
  invoiceDate: '2026-11-05',
  dueDate: '2026-12-05',
  netCents: 10000n,
  taxCents: 1900n,
  grossCents: 11900n,
  reverseCharge: false,
  taxLines: [{ ratePercent: '19.00', netCents: 10000n, taxCents: 1900n }],
  allocations: [allocation()],
  ...over,
})

const messages = (input: IncomingCheckInput) => incomingProblems(input).map((p) => p.message)

describe('Eingangsrechnung prüfen', () => {
  it('accepts a complete invoice split over a project and a business area', () => {
    expect(
      incomingProblems(
        valid({
          netCents: 15000n,
          taxCents: 2250n,
          grossCents: 17250n,
          taxLines: [
            { ratePercent: '19', netCents: 10000n, taxCents: 1900n },
            { ratePercent: '7', netCents: 5000n, taxCents: 350n },
          ],
          allocations: [
            allocation({ netCents: 6000n }),
            allocation({
              projectId: null,
              businessAreaId: 'b1',
              costType: 'other',
              netCents: 4000n,
            }),
            allocation({ ratePercent: '7.0', netCents: 5000n }),
          ],
        }),
      ),
    ).toEqual([])
    expect(incomingProblems(valid({ dueDate: null }))).toEqual([])
  })

  it('reports missing data and wrong sums in German', () => {
    expect(
      messages(
        valid({
          supplierName: ' ',
          invoiceNumber: null,
          invoiceDate: null,
          grossCents: 0n,
          taxLines: [],
          allocations: [],
        }),
      ),
    ).toEqual([
      'Der Lieferant fehlt.',
      'Die Rechnungsnummer des Lieferanten fehlt.',
      'Das Rechnungsdatum fehlt.',
      'Der Bruttobetrag muss größer als 0 sein.',
      'Netto + Umsatzsteuer ergibt 119,00 €, nicht 0,00 €.',
      'Mindestens ein Steuersatz mit Nettobetrag fehlt.',
      'Die Kosten sind noch keinem Projekt oder Betriebsbereich zugewiesen.',
    ])
    expect(messages(valid({ dueDate: '2026-11-01' }))).toEqual([
      'Die Fälligkeit liegt vor dem Rechnungsdatum.',
    ])
  })

  it('checks the tax lines against the totals', () => {
    expect(
      messages(
        valid({
          taxLines: [
            { ratePercent: '19', netCents: 9000n, taxCents: 1710n },
            { ratePercent: '19.0', netCents: 1001n, taxCents: 190n },
          ],
        }),
      ),
    ).toEqual([
      'Der Steuersatz 19 % ist doppelt angegeben.',
      'Die Nettobeträge je Steuersatz ergeben 100,01 €, nicht 100,00 €.',
      'Zum Steuersatz 19 % sind 89,99 € netto zu viel zugewiesen.',
    ])
    expect(
      messages(valid({ taxLines: [{ ratePercent: '19', netCents: 10000n, taxCents: 1800n }] })),
    ).toEqual(['Die Umsatzsteuer je Steuersatz ergibt 18,00 €, nicht 19,00 €.'])
  })

  it('checks every allocation and the sums per rate', () => {
    expect(
      messages(
        valid({
          allocations: [
            allocation({ projectId: 'p1', businessAreaId: 'b1', netCents: 12000n }),
            allocation({ projectId: null, netCents: 0n }),
            allocation({ ratePercent: '7', netCents: 100n }),
          ],
        }),
      ),
    ).toEqual([
      'Bitte genau ein Projekt oder einen Betriebsbereich wählen.',
      'Bitte genau ein Projekt oder einen Betriebsbereich wählen.',
      'Der zugewiesene Betrag muss größer als 0 sein.',
      'Der Steuersatz 7 % kommt in der Rechnung nicht vor.',
      'Zum Steuersatz 19 % sind 20,00 € netto zu viel zugewiesen.',
    ])
  })

  it('names a rate without any allocation', () => {
    expect(
      messages(
        valid({
          netCents: 10100n,
          taxCents: 1907n,
          grossCents: 12007n,
          taxLines: [
            { ratePercent: '19', netCents: 10000n, taxCents: 1900n },
            { ratePercent: '7', netCents: 100n, taxCents: 7n },
          ],
        }),
      ),
    ).toEqual(['Zum Steuersatz 7 % sind noch 1,00 € netto nicht zugewiesen.'])
  })

  it('requires an invoice without VAT for § 13b', () => {
    expect(messages(valid({ reverseCharge: true }))).toEqual([
      'Bei Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG) weist die Rechnung keine Umsatzsteuer aus.',
    ])
    const reverse = valid({
      reverseCharge: true,
      taxCents: 0n,
      grossCents: 10000n,
      taxLines: [{ ratePercent: '19', netCents: 10000n, taxCents: 0n }],
    })
    expect(incomingProblems(reverse)).toEqual([])
    expect(incomingWarnings(reverse)).toEqual([])
  })

  it('warns when the VAT does not fit the rate, with a cent of tolerance', () => {
    expect(incomingWarnings(valid())).toEqual([])
    expect(
      incomingWarnings(
        valid({ taxLines: [{ ratePercent: '19', netCents: 10000n, taxCents: 1901n }] }),
      ),
    ).toEqual([])
    expect(
      incomingWarnings(
        valid({ taxLines: [{ ratePercent: '7', netCents: 10000n, taxCents: 1900n }] }),
      ),
    ).toEqual([
      {
        field: 'taxLines',
        message:
          'Die Umsatzsteuer zu 7 % passt nicht zum Nettobetrag – bitte mit der Rechnung vergleichen.',
      },
    ])
  })

  it('shows negative differences with a sign', () => {
    expect(
      messages(valid({ netCents: -100n, taxCents: 0n, grossCents: 100n, taxLines: [] })).at(0),
    ).toBe('Netto + Umsatzsteuer ergibt -1,00 €, nicht 1,00 €.')
  })
})

describe('Vorsteuer je Zuweisung', () => {
  it('splits the tax of each rate proportionally and exactly', () => {
    const taxLines = [
      { ratePercent: '19', netCents: 10000n, taxCents: 1900n },
      { ratePercent: '7', netCents: 300n, taxCents: 21n },
    ]
    const allocations = [
      allocation({ netCents: 3333n }),
      allocation({ netCents: 3333n }),
      allocation({ netCents: 3334n }),
      allocation({ ratePercent: '7.00', netCents: 100n }),
      allocation({ ratePercent: '7', netCents: 200n }),
    ]
    const tax = allocationTax(allocations, taxLines)
    expect(tax).toEqual([633n, 633n, 634n, 7n, 14n])
    expect(tax.slice(0, 3).reduce((a, b) => a + b)).toBe(1900n)
  })

  it('distributes rounding remainders to the largest remainders, ties by order', () => {
    const tax = allocationTax(
      [allocation({ netCents: 1n }), allocation({ netCents: 1n }), allocation({ netCents: 1n })],
      [{ ratePercent: '19', netCents: 3n, taxCents: 2n }],
    )
    expect(tax).toEqual([1n, 1n, 0n])
    const rate = [{ ratePercent: '19', netCents: 3n, taxCents: 2n }]
    expect(
      allocationTax([allocation({ netCents: 2n }), allocation({ netCents: 1n })], rate),
    ).toEqual([1n, 1n])
    expect(
      allocationTax([allocation({ netCents: 1n }), allocation({ netCents: 2n })], rate),
    ).toEqual([1n, 1n])
  })

  it('leaves rates without allocations and unknown rates at zero', () => {
    expect(
      allocationTax(
        [allocation({ ratePercent: '7', netCents: 100n }), allocation({ netCents: 0n })],
        [
          { ratePercent: '19', netCents: 0n, taxCents: 0n },
          { ratePercent: '0', netCents: 100n, taxCents: 0n },
        ],
      ),
    ).toEqual([0n, 0n])
    expect(rateKey('19.00')).toBe('19')
  })
})

describe('Zu- und Abschläge auf Belegebene verteilen (BG-20/21)', () => {
  const line = (netCents: bigint, ratePercent: string | null = '19') => ({ netCents, ratePercent })

  it('spreads an allowance over the lines of its rate, exactly to the cent', () => {
    const result = distributeAllowanceCharges(
      [line(10000n), line(20000n), line(5000n, '7'), line(1n)],
      [{ charge: false, amountCents: 1000n, ratePercent: '19.00' }],
    )
    // 1000 over 10000/20000/1: 3,33 / 6,66 / 0,00 € plus the rounding cent for the largest remainder.
    expect(result.netCents).toEqual([9667n, 19333n, 5000n, 1n])
    expect(result.netCents.reduce((a, b) => a + b, 0n)).toBe(35001n - 1000n)
    expect(result.rest).toEqual([])
  })

  it('adds charges, nets allowances and charges of a rate and keeps rates apart', () => {
    const result = distributeAllowanceCharges(
      [line(10000n), line(10000n, '7')],
      [
        { charge: true, amountCents: 500n, ratePercent: '19' },
        { charge: false, amountCents: 200n, ratePercent: '19' },
        { charge: true, amountCents: 300n, ratePercent: '7' },
        { charge: true, amountCents: 400n, ratePercent: '19' },
        { charge: false, amountCents: 400n, ratePercent: '19' },
      ],
    )
    expect(result.netCents).toEqual([10300n, 10300n])
  })

  it('uses the only rate for an allowance without rate, otherwise leaves it as rest', () => {
    expect(
      distributeAllowanceCharges(
        [line(3000n), line(1000n)],
        [{ charge: false, amountCents: 100n, ratePercent: null }],
      ).netCents,
    ).toEqual([2925n, 975n])
    const mixed = distributeAllowanceCharges(
      [line(3000n), line(1000n, '7'), line(-500n, '0')],
      [
        { charge: false, amountCents: 100n, ratePercent: '' },
        { charge: true, amountCents: 250n, ratePercent: '0' },
        { charge: true, amountCents: 50n, ratePercent: '19' },
        { charge: false, amountCents: 50n, ratePercent: '19' },
      ],
    )
    expect(mixed.netCents).toEqual([3000n, 1000n, -500n])
    expect(mixed.rest).toEqual([
      { ratePercent: null, netCents: -100n },
      { ratePercent: '0', netCents: 250n },
    ])
  })

  it('leaves everything unchanged without allowances or charges', () => {
    expect(distributeAllowanceCharges([line(100n)], [])).toEqual({ netCents: [100n], rest: [] })
  })
})
