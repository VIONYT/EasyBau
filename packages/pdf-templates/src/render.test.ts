import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultLetterhead } from '@opc/domain'
import type { DocumentDetail } from '@opc/schemas'
import { describe, expect, it } from 'vitest'
import { documentLetter, documentTitle, germanQuantity } from './document.js'
import { renderLetterPdf } from './render.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

function sampleDocument(items = 3): DocumentDetail {
  return {
    id: 'doc',
    projectId: 'p',
    type: 'invoice',
    invoiceKind: 'final',
    progressNo: null,
    status: 'finalized',
    number: 'R2026-00103',
    subject: 'Sanierung Lindenweg',
    documentDate: '2026-11-21',
    netTotalCents: 2000,
    grossTotalCents: 2380,
    createdBy: null,
    updatedAt: '2026-11-21T10:00:00.000Z',
    changeOrder: null,
    cancelledBy: null,
    cancels: null,
    project: { id: 'p', number: 'P-00101', name: 'Sanierung Lindenweg' },
    contact: { id: 'c', displayName: 'Wohnbau Nord eG' },
    placeOfPerformance: 'Lindenweg 4, 30159 Hannover',
    serviceFrom: '2026-10-01',
    serviceTo: '2026-11-20',
    introText: 'Sehr geehrte Damen und Herren,\nwir berechnen: #set text(red) [x]',
    closingText: 'Mit freundlichen Grüßen',
    paymentDueDays: 14,
    discountPercent: null,
    taxMode: 'standard',
    cashDiscountPercent: null,
    cashDiscountDays: null,
    retentionPercent: '5',
    constructionLevyPercent: null,
    progressBillingMode: null,
    dueDate: '2026-12-05',
    cancelReason: null,
    legalNotes: ['Zahlbar ohne Abzug bis 05.12.2026.'],
    sourceDocumentId: null,
    validUntil: null,
    issuer: {
      name: 'Muster Bau GmbH',
      lines: ['Werkstraße 2', '30169 Hannover'],
      contact: [],
      legal: [],
      letterhead: { ...defaultLetterhead(), logo: { assetId: 'a', x: 25, y: 10, width: 30 } },
      values: {
        Firma: 'Muster Bau GmbH',
        Straße: 'Werkstraße 2',
        PLZ: '30169',
        Ort: 'Hannover',
        IBAN: 'DE89 3704 0044 0532 0130 00',
        Bank: 'Sparkasse Hannover',
      },
    },
    recipient: { name: 'Wohnbau Nord eG', lines: ['Lindenweg 4', '30159 Hannover'] },
    finalizedAt: '2026-11-21T10:00:00.000Z',
    changeOrderInfo: null,
    canConvertToChangeOrder: false,
    items: Array.from({ length: items }, (_, i) => ({
      id: `i${i}`,
      parentId: null,
      positionType: 'item' as const,
      oz: String(i + 1),
      level: 0,
      shortText: `Wandfläche streichen ${i + 1}`,
      longText: 'Untergrund prüfen, zweimal streichen.',
      quantity: '1234.5',
      unit: { id: 'u', symbol: 'm²', decimals: 2 },
      unitPriceCents: 1000,
      discountPercent: null,
      totalCents: 1234500,
      taxRatePercent: '19',
      fromMeasurement: false,
      cumulativeQuantity: null,
      previouslyBilledQuantity: null,
      calcMode: null,
      costLines: [],
      calculation: null,
    })),
    totals: {
      performance: { netCents: 107000, taxCents: 20330, grossCents: 127330 },
      deductions: [
        {
          documentId: 'd1',
          number: 'R2026-00101',
          invoiceKind: 'progress',
          progressNo: 1,
          documentDate: '2026-10-31',
          netCents: 105000,
          taxCents: 19950,
          grossCents: 124950,
        },
      ],
      retentionCents: 119,
      constructionLevyCents: 0,
      payableCents: 2261,
      cashDiscountCents: 0,
      itemsNetCents: 107000,
      discountCents: 0,
      netCents: 2000,
      taxCents: 380,
      grossCents: 2380,
      taxLines: [
        {
          category: 'S',
          ratePercent: '19.00',
          netCents: 2000,
          taxCents: 380,
          exemptionReason: null,
        },
      ],
      titleSubtotals: {},
      costCents: 0,
      marginCents: 0,
      laborHours: '0',
      uncalculatedCount: 0,
    },
  }
}

function pdfText(pdf: Buffer): { text: string; info: string } {
  const dir = mkdtempSync(join(tmpdir(), 'opc-pdf-'))
  const file = join(dir, 'doc.pdf')
  writeFileSync(file, pdf)
  return {
    text: execFileSync('pdftotext', ['-raw', file, '-'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString(),
    info: execFileSync('pdfinfo', [file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(),
  }
}

const hasPoppler = (() => {
  try {
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('PDF/A mit Typst', () => {
  it('formats German titles and quantities', () => {
    expect(
      documentTitle({ type: 'invoice', invoiceKind: 'progress', progressNo: 2, changeOrder: null }),
    ).toBe('2. Abschlagsrechnung')
    expect(
      documentTitle({
        type: 'change_order',
        invoiceKind: null,
        progressNo: null,
        changeOrder: { number: 1, basis: 'other', status: 'draft' },
      }),
    ).toBe('Nachtragsangebot N01')
    expect(germanQuantity('1234.5', 2)).toBe('1.234,50')
    expect(germanQuantity('-3', 0)).toBe('-3')
    expect(germanQuantity('0.125', 2)).toBe('0,125')
    expect(germanQuantity(null)).toBe('')
  })

  it('renders a PDF/A-3b letter on A4 with letterhead, address and legal notes', () => {
    const doc = sampleDocument()
    const { logoPosition, ...letter } = documentLetter(doc, { watermark: null })
    const pdf = renderLetterPdf(
      { ...letter, logo: logoPosition ? { ...logoPosition, data: PNG, mime: 'image/png' } : null },
      { createdAt: new Date('2026-11-21T10:00:00Z') },
    )
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const raw = pdf.toString('latin1')
    // XMP: PDF/A-3, conformance B.
    expect(raw).toMatch(/pdfaid:part(>|=")3/)
    expect(raw).toMatch(/pdfaid:conformance(>|=")B/)
    if (!hasPoppler) return
    const { text, info } = pdfText(pdf)
    expect(info).toMatch(/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/)
    expect(info).toMatch(/Title:\s+Schlussrechnung R2026-00103/)
    for (const expected of [
      'Muster Bau GmbH · Werkstraße 2 · 30169 Hannover',
      'Wohnbau Nord eG',
      'Lindenweg 4',
      'Schlussrechnung R2026-00103',
      'Abschlagsaufstellung',
      '1. Abschlagsrechnung R2026-00101 vom 31.10.2026',
      'Restbetrag dieser Rechnung',
      '1.234,50 m²',
      'Zahlbar ohne Abzug bis 05.12.2026.',
      'IBAN DE89 3704 0044 0532 0130 00',
      // Texts are never evaluated as Typst markup.
      '#set text(red) [x]',
    ]) {
      expect(text).toContain(expected)
    }
  })

  it('breaks long documents over several pages and adds the watermark of drafts', () => {
    const doc = { ...sampleDocument(40), status: 'draft' as const, number: null }
    const { logoPosition: _, ...letter } = documentLetter(doc, { watermark: 'ENTWURF' })
    const pdf = renderLetterPdf({ ...letter, logo: null })
    if (process.env.PDF_SAMPLE_DIR)
      writeFileSync(join(process.env.PDF_SAMPLE_DIR, 'draft.pdf'), pdf)
    if (!hasPoppler) return
    const { text, info } = pdfText(pdf)
    expect(Number(/Pages:\s+(\d+)/.exec(info)?.[1])).toBeGreaterThanOrEqual(3)
    expect(text).toContain('ENTWURF')
    // Footer on every page.
    expect(text.split('Sparkasse Hannover').length - 1).toBeGreaterThanOrEqual(3)
  })
})
