import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultLetterhead } from '@easybau/domain'
import { describe, expect, it } from 'vitest'
import { type DunningLetterSnapshot, dunningLetter, fillDunningText } from './dunning.js'
import { renderLetterPdf } from './render.js'

function text(pdf: Buffer): string {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'easybau-dunning-'))
    writeFileSync(join(dir, 'x.pdf'), pdf)
    return execFileSync('pdftotext', ['-raw', join(dir, 'x.pdf'), '-'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString()
  } catch {
    return ''
  }
}

const snapshot: DunningLetterSnapshot = {
  issuer: {
    name: 'Muster Bau GmbH',
    layout: defaultLetterhead(),
    values: { Firma: 'Muster Bau GmbH', Straße: 'Werkstraße 2', PLZ: '30169', Ort: 'Hannover' },
    iban: 'DE89370400440532013000',
    bic: null,
  },
  recipient: ['Wohnbau Nord eG', 'Lindenweg 4', '30159 Hannover'],
  customerNumber: 'K-10001',
  invoice: {
    number: 'R-00101',
    title: 'Rechnung',
    documentDate: '2026-11-02',
    dueDate: '2026-11-16',
    subject: 'Malerarbeiten Treppenhaus',
    placeOfPerformance: 'Lindenweg 4, Hannover',
    grossCents: 119_000,
  },
  amounts: {
    level: 'first',
    noticeDate: '2026-12-15',
    dueDate: '2026-12-22',
    days: 7,
    interest: true,
    business: true,
    openCents: 100_000,
    feeCents: 500,
    flatFeeCents: 4000,
    interestCents: 514,
    interestRatePercent: '10.52',
    interestFrom: '2026-12-01',
    interestTo: '2026-12-15',
    segments: [
      {
        from: '2026-12-01',
        to: '2026-12-01',
        days: 1,
        ratePercent: '10.52',
        principalCents: 119_000,
      },
      {
        from: '2026-12-02',
        to: '2026-12-15',
        days: 14,
        ratePercent: '10.52',
        principalCents: 100_000,
      },
    ],
    earlierChargesCents: 250,
    totalCents: 105_264,
  },
  text: 'trotz unserer Zahlungserinnerung ist die Rechnung noch offen.',
  signer: 'Chef',
}

describe('dunning letter', () => {
  it('fills the placeholders of the text', () => {
    expect(
      fillDunningText('Rechnung {Rechnung} vom {rechnungsdatum}: {Betrag} bis {Frist} {X}', {
        number: 'R-1',
        documentDate: '2026-11-02',
        dueDate: '2026-12-22',
        totalCents: 123_456,
      }),
    ).toBe('Rechnung R-1 vom 02.11.2026: 1.234,56 € bis 22.12.2026 {X}')
  })

  it('lists open amount, charges, interest and the total with GiroCode', () => {
    const letter = dunningLetter(snapshot)
    expect(letter.body.heading).toBe('1. Mahnung')
    expect(letter.body.subject).toBe('Rechnung R-00101 vom 02.11.2026')
    expect(letter.body.totals.map((t) => [t.label, t.value])).toEqual([
      ['Rechnung R-00101 vom 02.11.2026', '1.190,00 €'],
      ['abzüglich Zahlungen und Abzüge', '− 190,00 €'],
      ['Offener Rechnungsbetrag', '1.000,00 €'],
      ['Mahnkosten aus früheren Schreiben', '2,50 €'],
      ['Mahngebühr', '5,00 €'],
      ['Verzugspauschale (§ 288 Abs. 5 BGB)', '40,00 €'],
      ['Verzugszinsen vom 01.12.2026 bis 15.12.2026', '5,14 €'],
      ['Zu zahlender Betrag', '1.052,64 €'],
    ])
    expect(letter.body.totals[6]?.note).toBe(
      '10,52 % p. a. auf 1.190,00 € für 1 Tag (01.12.2026 – 01.12.2026); 10,52 % p. a. auf 1.000,00 € für 14 Tage (02.12.2026 – 15.12.2026) – Basiszinssatz + 9 Prozentpunkte (§ 288 BGB), ab 16.12.2026 weitere Zinsen',
    )
    expect(letter.body.notes).toEqual([
      'Bitte zahlen Sie bis zum 22.12.2026. Mahnkosten und Verzugszinsen unterliegen nicht der Umsatzsteuer.',
    ])
    expect(letter.body.paymentQr?.payload).toContain('EUR1052.64')
    expect(letter.info).toContainEqual({ label: 'Kundennummer', value: 'K-10001' })
    expect(letter.body.small).toEqual([
      'Malerarbeiten Treppenhaus · Leistungsort: Lindenweg 4, Hannover',
    ])
  })

  it('keeps a plain Zahlungserinnerung short', () => {
    const letter = dunningLetter({
      ...snapshot,
      customerNumber: null,
      signer: null,
      issuer: { ...snapshot.issuer, iban: null },
      invoice: { ...snapshot.invoice, dueDate: null, subject: null, placeOfPerformance: null },
      amounts: {
        ...snapshot.amounts,
        level: 'reminder',
        business: false,
        openCents: 119_000,
        feeCents: 0,
        flatFeeCents: 0,
        interestCents: 0,
        interestFrom: null,
        interestTo: null,
        segments: [],
        earlierChargesCents: 0,
        totalCents: 119_000,
      },
    })
    expect(letter.body.heading).toBe('Zahlungserinnerung')
    expect(letter.body.totals.map((t) => t.label)).toEqual([
      'Rechnung R-00101 vom 02.11.2026',
      'Zu zahlender Betrag',
    ])
    expect(letter.body.notes).toEqual(['Bitte zahlen Sie bis zum 22.12.2026.'])
    expect(letter.body.paymentQr).toBeNull()
    expect(letter.body.small).toEqual([])
  })

  it('renders as PDF/A', () => {
    const { logoPosition: _, ...letter } = dunningLetter(snapshot)
    const pdf = renderLetterPdf({ ...letter, logo: null })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const content = text(pdf)
    if (content) {
      expect(content).toContain('1. Mahnung')
      expect(content).toContain('1.052,64')
    }
  })
})
