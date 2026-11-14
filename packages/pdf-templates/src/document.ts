import {
  formatEuro,
  formatUnitQuantity,
  germanDate,
  giroCodePayload,
  type LetterheadValues,
} from '@opc/domain'
import type { DocumentDetail } from '@opc/schemas'
import { type LogoPosition, letterFrame } from './frame.js'
import type { LetterPdfInput } from './types.js'

/** German document titles (the PDF is a German business letter). */
const TYPE_LABEL: Record<string, string> = {
  quote: 'Angebot',
  cost_estimate: 'Kostenvoranschlag',
  order_confirmation: 'Auftragsbestätigung',
  change_order: 'Nachtragsangebot',
  delivery_note: 'Lieferschein',
  invoice: 'Rechnung',
  credit_note: 'Gutschrift',
}
const INVOICE_LABEL: Record<string, string> = {
  standard: 'Rechnung',
  partial: 'Teilrechnung',
  progress: 'Abschlagsrechnung',
  final: 'Schlussrechnung',
  cancellation: 'Stornorechnung',
}
const POSITION_NOTE: Record<string, string> = {
  optional: 'Bedarfsposition – nicht in der Summe',
  alternative: 'Alternativposition – nicht in der Summe',
}

export function documentTitle(
  doc: Pick<DocumentDetail, 'type' | 'invoiceKind' | 'progressNo' | 'changeOrder'>,
): string {
  if (doc.type === 'invoice' && doc.invoiceKind) {
    const label = INVOICE_LABEL[doc.invoiceKind] ?? 'Rechnung'
    return doc.invoiceKind === 'progress' && doc.progressNo ? `${doc.progressNo}. ${label}` : label
  }
  const label = TYPE_LABEL[doc.type] ?? doc.type
  return doc.changeOrder ? `${label} N${String(doc.changeOrder.number).padStart(2, '0')}` : label
}

const euro = (cents: number | null | undefined) => (cents == null ? '' : formatEuro(BigInt(cents)))
const date = (iso: string) => germanDate(iso)

/** Quantity with the decimals of its unit (Handwerksregel): "186.4" m² → "186,40". */
export function germanQuantity(value: string | null, decimals = 2): string {
  return value === null ? '' : formatUnitQuantity(value, decimals)
}

/** Percent without trailing zeros: "2.5000" → "2,5", "19.00" → "19". */
export function germanPercent(value: string | null): string {
  if (!value) return ''
  return (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value).replace(
    '.',
    ',',
  )
}

const percent = germanPercent

/** Builds the template data of a document; logo bytes are added by the caller. */
export function documentLetter(
  doc: DocumentDetail,
  options: {
    watermark: string | null
    /** Bild-Positionen: item id → image path (assets); missing images are left out. */
    images?: ReadonlyMap<string, string>
  },
): Omit<LetterPdfInput, 'logo'> & { logoPosition: LogoPosition | null } {
  const values: LetterheadValues = doc.issuer.values ?? {
    Firma: doc.issuer.name,
    Straße: doc.issuer.lines[0] ?? null,
    Ort: doc.issuer.lines[1] ?? null,
  }
  const title = documentTitle(doc)
  const info = [
    { label: 'Nummer', value: doc.number ?? 'Entwurf' },
    { label: 'Datum', value: date(doc.documentDate) },
  ]
  if (doc.validUntil) info.push({ label: 'Gültig bis', value: date(doc.validUntil) })
  if (doc.serviceFrom || doc.serviceTo) {
    info.push({
      label: 'Leistungszeitraum',
      value: [doc.serviceFrom, doc.serviceTo]
        .filter((d, i, all): d is string => !!d && all.indexOf(d) === i)
        .map(date)
        .join(' – '),
    })
  }
  if (doc.dueDate) info.push({ label: 'Fällig am', value: date(doc.dueDate) })
  info.push({
    label: 'Projekt',
    value: [doc.project.number, doc.project.name].filter(Boolean).join(' · '),
  })

  const items: LetterPdfInput['body']['items'] = []
  for (const item of doc.items) {
    if (item.positionType === 'title') {
      items.push({
        kind: 'title',
        oz: item.oz ?? '',
        text: item.shortText ?? '',
        total: euro(doc.totals.titleSubtotals[item.id] ?? 0),
      })
    } else if (item.positionType === 'text') {
      items.push({ kind: 'text', text: item.longText ?? item.shortText ?? '' })
    } else if (item.positionType === 'image') {
      const path = options.images?.get(item.id)
      if (path) items.push({ kind: 'image', path, caption: item.shortText })
    } else if (item.positionType !== 'subtotal') {
      const counted = item.positionType === 'item' || item.positionType === 'lump_sum'
      items.push({
        kind: 'item',
        oz: item.oz ?? '',
        text: item.shortText ?? '',
        note: POSITION_NOTE[item.positionType] ?? null,
        longText: item.longText,
        quantity:
          `${germanQuantity(item.quantity, item.unit?.decimals ?? 2)} ${item.unit?.symbol ?? ''}`.trim(),
        unitPrice: euro(item.unitPriceCents),
        total: counted ? euro(item.totalCents) : `(${euro(item.totalCents)})`,
      })
    }
  }

  const t = doc.totals
  const totals: LetterPdfInput['body']['totals'] = [
    { label: 'Summe netto', value: euro(t.itemsNetCents), grand: false, note: null },
  ]
  if (t.discountCents) {
    totals.push(
      {
        label: `Rabatt ${percent(doc.discountPercent)} %`,
        value: `− ${euro(t.discountCents)}`,
        grand: false,
        note: null,
      },
      { label: 'Netto nach Rabatt', value: euro(t.netCents), grand: false, note: null },
    )
  }
  for (const line of t.taxLines) {
    totals.push({
      label: `USt ${germanPercent(line.ratePercent)} % (${euro(line.netCents)})`,
      value: euro(line.taxCents),
      grand: false,
      note: line.exemptionReason,
    })
  }
  totals.push({
    label: t.deductions.length ? 'Restbetrag brutto' : 'Gesamtbetrag brutto',
    value: euro(t.grossCents),
    grand: true,
    note: null,
  })
  if (t.retentionCents) {
    totals.push({
      label: `Sicherheitseinbehalt ${percent(doc.retentionPercent)} %`,
      value: `− ${euro(t.retentionCents)}`,
      grand: false,
      note: null,
    })
  }
  if (t.constructionLevyCents) {
    totals.push({
      label: `Bauumlage ${percent(doc.constructionLevyPercent)} %`,
      value: `− ${euro(t.constructionLevyCents)}`,
      grand: false,
      note: null,
    })
  }
  if (t.retentionCents || t.constructionLevyCents) {
    totals.push({ label: 'Zahlbetrag', value: euro(t.payableCents), grand: true, note: null })
  }

  const small: string[] = []
  if (doc.placeOfPerformance) small.push(`Leistungsort: ${doc.placeOfPerformance}`)
  if (doc.changeOrderInfo) {
    small.push(
      `Nachtrag zum Hauptauftrag ${doc.changeOrderInfo.contractLabel}${doc.changeOrderInfo.reason ? ` – ${doc.changeOrderInfo.reason}` : ''}`,
    )
  }
  const notes = doc.legalNotes.length
    ? doc.legalNotes
    : doc.paymentDueDays !== null
      ? [`Zahlbar innerhalb von ${doc.paymentDueDays} Tagen ohne Abzug.`]
      : []

  return {
    ...letterFrame({
      issuerName: doc.issuer.name,
      layout: doc.issuer.letterhead,
      values,
      recipient: doc.recipient ? [doc.recipient.name, ...doc.recipient.lines] : [],
      info,
      title: `${title}${doc.number ? ` ${doc.number}` : ''}`,
      watermark: options.watermark,
    }),
    body: {
      heading: `${title}${doc.number ? ` ${doc.number}` : ''}`,
      subject: doc.subject,
      small,
      intro: doc.introText,
      columns: ['Pos.', 'Leistung', 'Menge', 'EP', 'GP'],
      items,
      deductions: t.deductions.length
        ? {
            title: 'Abschlagsaufstellung',
            columns: ['', 'Netto', 'USt', 'Brutto'],
            rows: [
              {
                label: 'Gesamtleistung',
                net: euro(t.performance.netCents),
                tax: euro(t.performance.taxCents),
                gross: euro(t.performance.grossCents),
              },
              ...t.deductions.map((d) => ({
                label: `− ${documentTitle({ type: 'invoice', invoiceKind: d.invoiceKind, progressNo: d.progressNo, changeOrder: null })} ${d.number ?? ''} vom ${date(d.documentDate)}`,
                net: `− ${euro(d.netCents)}`,
                tax: `− ${euro(d.taxCents)}`,
                gross: `− ${euro(d.grossCents)}`,
              })),
            ],
            rest: {
              label: 'Restbetrag dieser Rechnung',
              net: euro(t.netCents),
              tax: euro(t.taxCents),
              gross: euro(t.grossCents),
            },
          }
        : null,
      totals,
      notes,
      paymentQr: paymentQrOf(doc, options.watermark),
      closing: doc.closingText,
      blocks: [],
    },
  }
}

/**
 * GiroCode on finalized invoices (not on drafts, Stornorechnungen or credit notes): company, IBAN,
 * Zahlbetrag without Skonto (gross − Einbehalt − Bauumlage) and the invoice number.
 */
function paymentQrOf(
  doc: DocumentDetail,
  watermark: string | null,
): { payload: string; lines: string[] } | null {
  if (watermark || !doc.number || doc.type !== 'invoice' || doc.invoiceKind === 'cancellation') {
    return null
  }
  const iban = doc.issuer.einvoice?.iban ?? doc.issuer.values?.IBAN ?? null
  const amountCents = BigInt(doc.totals.payableCents)
  const payload = giroCodePayload({
    name: doc.issuer.name,
    iban,
    bic: doc.issuer.einvoice?.bic ?? doc.issuer.values?.BIC ?? null,
    amountCents,
    reference: doc.number,
  })
  if (!payload) return null
  return {
    payload,
    lines: [
      'Bezahlen mit GiroCode',
      'Mit der Banking-App scannen.',
      `Betrag: ${euro(Number(amountCents))}`,
      `Verwendungszweck: ${doc.number}`,
    ],
  }
}
