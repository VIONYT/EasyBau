import { describe, expect, it } from 'vitest'
import {
  addDays,
  billingQuantity,
  checkInvoiceRequirements,
  contributedQuantity,
  formatEuro,
  germanDate,
  type InvoiceRequirementsInput,
  invoiceLegalNotes,
  isCumulativeInvoice,
  type LegalNotesInput,
  laborShareNote,
  negateQuantity,
} from './billing.js'
import { calculateDocumentTotals } from './document.js'

describe('Abschläge und Schlussrechnung (§ 14 Abs. 5 UStG)', () => {
  const item = (id: string, cents: bigint, rate = '19') => ({
    id,
    positionType: 'item' as const,
    totalCents: cents,
    taxRatePercent: rate,
  })

  it('deducts earlier progress invoices per tax rate (reference example)', () => {
    // Gesamtleistung 10.000,00 € netto; 1. Abschlag 3.000,00 €, 2. Abschlag 4.000,00 €.
    const totals = calculateDocumentTotals({
      lines: [item('a', 1_000_000n)],
      retentionPercent: '5',
      deductions: [
        {
          id: 'A1',
          taxLines: [{ category: 'S', ratePercent: '19', netCents: 300_000n, taxCents: 57_000n }],
        },
        {
          id: 'A2',
          taxLines: [{ category: 'S', ratePercent: '19', netCents: 400_000n, taxCents: 76_000n }],
        },
      ],
    })
    expect(totals.performance).toEqual({
      netCents: 1_000_000n,
      taxCents: 190_000n,
      grossCents: 1_190_000n,
    })
    expect(totals.deductions).toEqual([
      { id: 'A1', netCents: 300_000n, taxCents: 57_000n, grossCents: 357_000n },
      { id: 'A2', netCents: 400_000n, taxCents: 76_000n, grossCents: 476_000n },
    ])
    // Restbetrag = Bemessungsgrundlage dieser Rechnung.
    expect([totals.netCents, totals.taxCents, totals.grossCents]).toEqual([
      300_000n,
      57_000n,
      357_000n,
    ])
    expect(totals.taxLines).toEqual([
      {
        category: 'S',
        ratePercent: '19.00',
        netCents: 300_000n,
        taxCents: 57_000n,
        itemsNetCents: 1_000_000n,
        discountCents: 0n,
        deductedNetCents: 700_000n,
      },
    ])
    // 5 % Sicherheitseinbehalt vom Restbetrag brutto.
    expect(totals.retentionCents).toBe(17_850n)
    expect(totals.payableCents).toBe(339_150n)
  })

  it('computes the tax on the remaining base and keeps the table consistent', () => {
    const totals = calculateDocumentTotals({
      lines: [item('a', 100_005n)],
      deductions: [
        {
          id: 'A1',
          taxLines: [{ category: 'S', ratePercent: '19', netCents: 66_670n, taxCents: 12_667n }],
        },
      ],
    })
    // 333,35 € × 19 % = 63,3365 € → 63,34 € (BR-CO-17); Gesamtleistung = Rest + Abzug.
    expect(totals.taxLines[0]).toMatchObject({ netCents: 33_335n, taxCents: 6_334n })
    // EN 16931: base = positions − document discount − deducted net (document-level allowances).
    expect(totals.taxLines[0]).toMatchObject({
      itemsNetCents: 100_005n,
      discountCents: 0n,
      deductedNetCents: 66_670n,
    })
    expect(totals.performance.taxCents).toBe(6_334n + 12_667n)
    expect(totals.performance.grossCents).toBe(totals.grossCents + 66_670n + 12_667n)
  })

  it('handles rates that only appear in a deducted invoice and overbilling', () => {
    const totals = calculateDocumentTotals({
      lines: [item('a', 50_000n)],
      cashDiscountPercent: '2',
      deductions: [
        {
          id: 'A1',
          taxLines: [
            { category: 'S', ratePercent: '19', netCents: 60_000n, taxCents: 11_400n },
            { category: 'S', ratePercent: '7', netCents: 1_000n, taxCents: 70n },
          ],
        },
      ],
    })
    expect(totals.taxLines.map((t) => [t.ratePercent, t.netCents, t.taxCents])).toEqual([
      ['19.00', -10_000n, -1_900n],
      ['7.00', -1_000n, -70n],
    ])
    // Nothing to pay: no retention, no cash discount on a negative amount.
    expect(totals.grossCents).toBe(-12_970n)
    expect(totals.retentionCents).toBe(0n)
    expect(totals.cashDiscountCents).toBe(0n)
  })
})

describe('Mengenfortschreibung', () => {
  it('knows which invoices show the total performance', () => {
    expect(isCumulativeInvoice('final', null)).toBe(true)
    expect(isCumulativeInvoice('progress', 'cumulative')).toBe(true)
    expect(isCumulativeInvoice('progress', null)).toBe(true)
    expect(isCumulativeInvoice('progress', 'individual')).toBe(false)
    expect(isCumulativeInvoice('standard', null)).toBe(false)
    expect(isCumulativeInvoice('partial', 'cumulative')).toBe(false)
  })

  it('bills measured to date minus already billed (individual) or to date (cumulative)', () => {
    expect(
      billingQuantity({ measured: '120,5', previouslyBilled: '80', cumulative: false }).toString(),
    ).toBe('40.5')
    expect(
      billingQuantity({ measured: '120,5', previouslyBilled: '80', cumulative: true }).toString(),
    ).toBe('120.5')
    // Mindermenge: more billed than measured → negative quantity.
    expect(
      billingQuantity({ measured: 70, previouslyBilled: 80, cumulative: false }).toString(),
    ).toBe('-10')
  })

  it('derives what an invoice contributed to the billed quantity', () => {
    expect(
      contributedQuantity({
        quantity: '120.5',
        previouslyBilled: '80',
        cumulative: true,
      }).toString(),
    ).toBe('40.5')
    expect(
      contributedQuantity({
        quantity: '120.5',
        previouslyBilled: null,
        cumulative: true,
      }).toString(),
    ).toBe('120.5')
    expect(
      contributedQuantity({
        quantity: '40.5',
        previouslyBilled: '80',
        cumulative: false,
      }).toString(),
    ).toBe('40.5')
  })

  it('negates quantities for cancellations', () => {
    expect(negateQuantity('12.5')).toBe('-12.5')
    expect(negateQuantity('-3')).toBe('3')
  })
})

describe('Formatierung', () => {
  it('formats dates and amounts in German', () => {
    expect(addDays('2026-12-20', 14)).toBe('2027-01-03')
    expect(germanDate('2026-11-09')).toBe('09.11.2026')
    expect(formatEuro(123_456_789n)).toBe('1.234.567,89 €')
    expect(formatEuro(5n)).toBe('0,05 €')
    expect(formatEuro(-1_990n)).toBe('-19,90 €')
  })
})

describe('Pflichtangaben § 14 Abs. 4 UStG', () => {
  const complete: InvoiceRequirementsInput = {
    issuer: {
      name: 'Muster Bau GmbH',
      street: 'Werkstraße 2',
      postalCode: '30169',
      city: 'Hannover',
      taxNumber: '25/123/45678',
      vatId: null,
    },
    recipient: { name: 'Wohnbau Nord eG', lines: ['Lindenweg 4', '30159 Hannover'] },
    recipientVatId: null,
    documentDate: '2026-11-09',
    serviceFrom: '2026-10-01',
    serviceTo: '2026-10-31',
    pricedItemCount: 3,
    taxMode: 'standard',
  }

  it('accepts a complete invoice', () => {
    expect(checkInvoiceRequirements(complete)).toEqual([])
    expect(
      checkInvoiceRequirements({
        ...complete,
        serviceFrom: null,
        issuer: { ...complete.issuer, taxNumber: null, vatId: 'DE123456789' },
      }),
    ).toEqual([])
  })

  it('names every missing mandatory field', () => {
    const problems = checkInvoiceRequirements({
      issuer: {
        name: 'Muster Bau',
        street: null,
        postalCode: null,
        city: null,
        taxNumber: null,
        vatId: null,
      },
      recipient: null,
      recipientVatId: null,
      documentDate: '2026-11-09',
      serviceFrom: null,
      serviceTo: null,
      pricedItemCount: 0,
      taxMode: 'intra_eu',
    })
    expect(problems.map((p) => p.field)).toEqual([
      'company',
      'company',
      'contactId',
      'contactId',
      'serviceFrom',
      'items',
    ])
    expect(problems[4]?.message).toBe('Leistungsdatum oder Leistungszeitraum fehlt.')
  })

  it('checks recipient address and service date plausibility', () => {
    expect(
      checkInvoiceRequirements({
        ...complete,
        recipient: { name: 'Wohnbau', lines: [] },
        serviceFrom: '2026-12-01',
      }).map((p) => p.message),
    ).toEqual([
      'Empfänger mit vollständiger Anschrift fehlt.',
      'Die Leistung beginnt nach dem Rechnungsdatum. Bitte Datum prüfen.',
    ])
    expect(
      checkInvoiceRequirements({ ...complete, taxMode: 'intra_eu', recipientVatId: 'ATU12345678' }),
    ).toEqual([])
  })
})

describe('Pflichthinweise', () => {
  const base: LegalNotesInput = {
    kind: 'standard',
    taxMode: 'standard',
    recipientIsPrivate: false,
    documentDate: '2026-11-09',
    paymentDueDays: 14,
    cashDiscount: null,
    progressNo: null,
    cancels: null,
  }

  it('prints the due date and cash discount with dates and amount', () => {
    expect(invoiceLegalNotes(base)).toEqual(['Zahlbar ohne Abzug bis 23.11.2026.'])
    expect(
      invoiceLegalNotes({
        ...base,
        cashDiscount: { percent: '2.5', days: 7, amountCents: 3_570n },
      }),
    ).toEqual([
      'Bei Zahlung bis 16.11.2026 gewähren wir 2,5 % Skonto (35,70 €). Ohne Abzug zahlbar bis 23.11.2026.',
    ])
    expect(
      invoiceLegalNotes({
        ...base,
        paymentDueDays: null,
        cashDiscount: { percent: '2', days: 7, amountCents: 0n },
      }),
    ).toEqual([])
  })

  it('adds § 13b, final invoice, progress and private customer notes', () => {
    const notes = invoiceLegalNotes({
      ...base,
      kind: 'final',
      taxMode: 'reverse_charge_13b',
      recipientIsPrivate: true,
      paymentDueDays: 0,
    })
    expect(notes[0]).toMatch(/abschließend abgerechnet/)
    expect(notes[1]).toMatch(/§ 13b/)
    expect(notes[2]).toBe('Zahlbar ohne Abzug bis 09.11.2026.')
    expect(notes[3]).toMatch(/zwei Jahre lang aufzubewahren/)
    expect(
      invoiceLegalNotes({ ...base, kind: 'progress', progressNo: 2, paymentDueDays: null }),
    ).toEqual(['2. Abschlagsrechnung nach erbrachtem Leistungsstand.'])
    expect(
      invoiceLegalNotes({ ...base, taxMode: 'small_business', paymentDueDays: null })[0],
    ).toMatch(/§ 19 UStG/)
  })

  it('explains a cancellation without payment terms or retention note', () => {
    expect(
      invoiceLegalNotes({
        ...base,
        kind: 'cancellation',
        recipientIsPrivate: true,
        cancels: { number: 'R-00101', reason: 'Falscher Empfänger' },
      }),
    ).toEqual([
      'Diese Stornorechnung hebt die Rechnung R-00101 vollständig auf. Grund: Falscher Empfänger',
    ])
  })
})

describe('Lohnkostenanteil § 35a EStG', () => {
  it('prints the labor costs including VAT and net, not on cancellations', () => {
    expect(laborShareNote(null)).toBeNull()
    expect(laborShareNote({ netCents: 0n, grossCents: 0n })).toBeNull()
    expect(laborShareNote({ netCents: 100_000n, grossCents: 119_000n })).toBe(
      'Im Betrag enthaltene Arbeitskosten (Lohn-, Maschinen- und Fahrtkosten) nach § 35a EStG: 1.190,00 € inkl. USt (netto 1.000,00 €).',
    )
    expect(laborShareNote({ netCents: 50_000n, grossCents: 50_000n })).toBe(
      'Im Betrag enthaltene Arbeitskosten (Lohn-, Maschinen- und Fahrtkosten) nach § 35a EStG: 500,00 €.',
    )
    const base = {
      kind: 'standard' as const,
      taxMode: 'standard' as const,
      recipientIsPrivate: true,
      documentDate: '2026-11-09',
      paymentDueDays: null,
      cashDiscount: null,
      progressNo: null,
      cancels: null,
      laborShare: { netCents: 100n, grossCents: 119n },
    }
    expect(invoiceLegalNotes(base)[0]).toMatch(/§ 35a EStG: 1,19 €/)
    expect(
      invoiceLegalNotes({ ...base, kind: 'cancellation', cancels: { number: 'R1', reason: 'x' } }),
    ).toHaveLength(1)
  })
})
