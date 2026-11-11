// Test fixtures: realistic finalized documents whose totals come from the real domain calculation.
import { calculateDocumentTotals, type PositionType, type TaxMode } from '@opc/domain'
import type { DocumentDetail, DocumentItem } from '@opc/schemas'

export const UNIT_CODES = new Map([
  ['u-m2', 'MTK'],
  ['u-h', 'HUR'],
  ['u-stk', 'H87'],
  ['u-psch', 'LS'],
])

const units = {
  m2: { id: 'u-m2', symbol: 'm²', decimals: 2 },
  h: { id: 'u-h', symbol: 'Std', decimals: 2 },
  stk: { id: 'u-stk', symbol: 'Stk', decimals: 0 },
  psch: { id: 'u-psch', symbol: 'psch', decimals: 0 },
}

type ItemInput = {
  oz: string
  text: string
  quantity: string
  unit: keyof typeof units
  priceCents: number
  rate?: string
  discount?: string
  type?: 'item' | 'lump_sum'
  longText?: string
}

export function item(input: ItemInput): DocumentItem {
  const gross =
    (BigInt(Math.round(Number(input.quantity) * 10000)) * BigInt(input.priceCents)) / 10000n
  const factor = input.discount ? 10000n - BigInt(Math.round(Number(input.discount) * 100)) : 10000n
  const total = (gross * factor + 5000n) / 10000n
  return {
    id: `i-${input.oz}`,
    parentId: null,
    positionType: input.type ?? 'item',
    oz: input.oz,
    level: 0,
    shortText: input.text,
    longText: input.longText ?? null,
    quantity: input.quantity,
    unit: units[input.unit],
    unitPriceCents: input.priceCents,
    discountPercent: input.discount ?? null,
    totalCents: Number(total),
    taxRatePercent: input.rate ?? '19',
    fromMeasurement: false,
    cumulativeQuantity: null,
    previouslyBilledQuantity: null,
    calcMode: null,
    costLines: [],
    calculation: null,
  }
}

export interface InvoiceOptions {
  number?: string
  kind?: DocumentDetail['invoiceKind']
  type?: 'invoice' | 'credit_note'
  taxMode?: TaxMode
  discountPercent?: string | null
  retentionPercent?: string | null
  constructionLevyPercent?: string | null
  cashDiscount?: { percent: string; days: number } | null
  deductions?: { number: string; date: string; netCents: number; rate?: string }[]
  recipient?: Partial<NonNullable<DocumentDetail['recipient']>>
  issuer?: Partial<NonNullable<DocumentDetail['issuer']['einvoice']>>
  cancels?: { id: string; number: string } | null
  serviceFrom?: string | null
  serviceTo?: string | null
}

export function invoice(items: DocumentItem[], options: InvoiceOptions = {}): DocumentDetail {
  const taxMode = options.taxMode ?? 'standard'
  const deductions = (options.deductions ?? []).map((d, i) => ({
    id: `d${i}`,
    taxLines: [
      {
        category: 'S' as const,
        ratePercent: d.rate ?? '19',
        netCents: BigInt(d.netCents),
        taxCents: BigInt(Math.round((d.netCents * Number(d.rate ?? '19')) / 100)),
      },
    ],
  }))
  const t = calculateDocumentTotals({
    taxMode,
    ...(options.discountPercent ? { discountPercent: options.discountPercent } : {}),
    ...(options.retentionPercent ? { retentionPercent: options.retentionPercent } : {}),
    ...(options.constructionLevyPercent
      ? { constructionLevyPercent: options.constructionLevyPercent }
      : {}),
    ...(options.cashDiscount ? { cashDiscountPercent: options.cashDiscount.percent } : {}),
    deductions,
    lines: items.map((i) => ({
      id: i.id,
      parentId: i.parentId,
      positionType: i.positionType as PositionType,
      totalCents: BigInt(i.totalCents ?? 0),
      ...(i.taxRatePercent ? { taxRatePercent: i.taxRatePercent } : {}),
    })),
  })
  const n = (v: bigint) => Number(v)
  return {
    id: 'doc',
    projectId: 'p',
    type: options.type ?? 'invoice',
    invoiceKind: options.type === 'credit_note' ? null : (options.kind ?? 'standard'),
    progressNo: null,
    status: 'finalized',
    number: options.number ?? 'R2026-00103',
    subject: 'Sanierung Lindenweg 4 – Malerarbeiten',
    documentDate: '2026-11-21',
    netTotalCents: n(t.netCents),
    grossTotalCents: n(t.grossCents),
    createdBy: null,
    updatedAt: '2026-11-21T10:00:00.000Z',
    changeOrder: null,
    cancelledBy: null,
    cancels: options.cancels ?? null,
    project: { id: 'p', number: 'P-00101', name: 'Sanierung Lindenweg 4' },
    contact: { id: 'c', displayName: 'Wohnbau Nord eG' },
    placeOfPerformance: 'Lindenweg 4, 30159 Hannover',
    serviceFrom: options.serviceFrom === undefined ? '2026-10-01' : options.serviceFrom,
    serviceTo: options.serviceTo === undefined ? '2026-11-20' : options.serviceTo,
    introText: null,
    closingText: null,
    paymentDueDays: 14,
    discountPercent: options.discountPercent ?? null,
    taxMode,
    cashDiscountPercent: options.cashDiscount?.percent ?? null,
    cashDiscountDays: options.cashDiscount?.days ?? null,
    retentionPercent: options.retentionPercent ?? null,
    constructionLevyPercent: options.constructionLevyPercent ?? null,
    progressBillingMode: null,
    dueDate: '2026-12-05',
    cancelReason: options.cancels ? 'Falscher Leistungszeitraum' : null,
    legalNotes: ['Bitte bewahren Sie diese Rechnung zwei Jahre auf.'],
    sourceDocumentId: null,
    validUntil: null,
    issuer: {
      name: 'Muster Bau GmbH',
      lines: ['Werkstraße 2', '30169 Hannover'],
      contact: [],
      legal: [],
      address: {
        street: 'Werkstraße 2',
        streetExtra: null,
        postalCode: '30169',
        city: 'Hannover',
        countryCode: 'DE',
      },
      einvoice: {
        vatId: 'DE123456789',
        taxNumber: '25/123/45678',
        email: 'buero@muster-bau.example',
        phone: '+49 511 123456',
        contactName: 'Erika Meister',
        iban: 'DE89370400440532013000',
        bic: 'COBADEFFXXX',
        ...options.issuer,
      },
    },
    recipient: {
      name: 'Wohnbau Nord eG',
      lines: ['Lindenweg 4', '30159 Hannover'],
      vatId: null,
      address: {
        street: 'Lindenweg 4',
        streetExtra: null,
        postalCode: '30159',
        city: 'Hannover',
        countryCode: 'DE',
      },
      customerNumber: 'K-10042',
      buyerReference: null,
      einvoiceEmail: null,
      einvoiceFormat: null,
      ...options.recipient,
    },
    finalizedAt: '2026-11-21T10:00:00.000Z',
    changeOrderInfo: null,
    canConvertToChangeOrder: false,
    items,
    totals: {
      performance: {
        netCents: n(t.performance.netCents),
        taxCents: n(t.performance.taxCents),
        grossCents: n(t.performance.grossCents),
      },
      deductions: (options.deductions ?? []).map((d, i) => ({
        documentId: `d${i}`,
        number: d.number,
        invoiceKind: 'progress' as const,
        progressNo: i + 1,
        documentDate: d.date,
        netCents: n(t.deductions[i]?.netCents ?? 0n),
        taxCents: n(t.deductions[i]?.taxCents ?? 0n),
        grossCents: n(t.deductions[i]?.grossCents ?? 0n),
      })),
      retentionCents: n(t.retentionCents),
      constructionLevyCents: n(t.constructionLevyCents),
      payableCents: n(t.payableCents),
      cashDiscountCents: n(t.cashDiscountCents),
      itemsNetCents: n(t.itemsNetCents),
      discountCents: n(t.discountCents),
      netCents: n(t.netCents),
      taxCents: n(t.taxCents),
      grossCents: n(t.grossCents),
      taxLines: t.taxLines.map((l) => ({
        category: l.category,
        ratePercent: l.ratePercent,
        netCents: n(l.netCents),
        taxCents: n(l.taxCents),
        exemptionReason: l.exemptionReason ?? null,
        itemsNetCents: n(l.itemsNetCents),
        discountCents: n(l.discountCents),
        deductedNetCents: n(l.deductedNetCents),
      })),
      titleSubtotals: {},
      costCents: 0,
      marginCents: 0,
      laborHours: '0',
      uncalculatedCount: 0,
    },
  }
}

/** Typical Malerarbeiten: area at 19 %, hourly work with 5 % discount, a lump sum. */
export const standardItems = () => [
  item({
    oz: '01.01',
    text: 'Wandflächen grundieren & streichen',
    quantity: '186.4',
    unit: 'm2',
    priceCents: 1250,
    longText: 'Untergrund prüfen, zweimal deckend <weiß>.',
  }),
  item({
    oz: '01.02',
    text: 'Regiestunden Maler',
    quantity: '7.5',
    unit: 'h',
    priceCents: 5800,
    discount: '5',
  }),
  item({
    oz: '01.03',
    text: 'Baustelleneinrichtung',
    quantity: '1',
    unit: 'psch',
    priceCents: 25000,
    type: 'lump_sum',
  }),
]

/**
 * Validates XML with the KoSIT daemon when KOSIT_URL is set (Docker test pipeline, CI); returns
 * null otherwise so unit tests still check the structure.
 */
export async function kosit(xml: string): Promise<{ status: number; report: string } | null> {
  const url = process.env.KOSIT_URL
  if (!url) return null
  const res = await fetch(`${url.replace(/\/+$/, '')}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: xml,
  })
  return { status: res.status, report: await res.text() }
}
