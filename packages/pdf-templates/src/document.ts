import {
  DIN5008B,
  defaultLetterhead,
  fillPlaceholders,
  formatEuro,
  germanDate,
  type LetterheadValues,
} from '@opc/domain'
import type { DocumentDetail } from '@opc/schemas'
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

/** "1234.5" → "1.234,50" with the decimals of the unit (Handwerksregel). */
export function germanQuantity(value: string | null, decimals = 2): string {
  if (value === null) return ''
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const digits = fraction
    .padEnd(decimals, '0')
    .slice(0, Math.max(decimals, fraction.replace(/0+$/, '').length))
  return `${negative ? '-' : ''}${grouped}${digits ? `,${digits}` : ''}`
}

const percent = (value: string | null) => (value ? germanQuantity(value, 0) : '')

/** Builds the template data of a document; logo bytes are added by the caller. */
export function documentLetter(
  doc: DocumentDetail,
  options: { watermark: string | null },
): Omit<LetterPdfInput, 'logo'> & {
  logoPosition: { assetId: string; x: number; y: number; width: number; maxHeight: number } | null
} {
  const layout = doc.issuer.letterhead ?? defaultLetterhead()
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
    } else if (item.positionType !== 'subtotal' && item.positionType !== 'image') {
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
      label: `USt ${germanQuantity(line.ratePercent.replace(/\.?0+$/, ''), 0)} % (${euro(line.netCents)})`,
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
    title: `${title}${doc.number ? ` ${doc.number}` : ''}`,
    author: doc.issuer.name,
    font: layout.font,
    accent: layout.accentColor,
    foldMarks: layout.foldMarks,
    watermark: options.watermark,
    logoPosition: layout.logo
      ? {
          ...layout.logo,
          maxHeight: Math.max(DIN5008B.header.height - layout.logo.y, 5),
        }
      : null,
    texts: layout.texts
      .map((x) => ({ ...x, text: fillPlaceholders(x.text, values) }))
      .filter((x) => x.text.trim() !== '')
      .map(({ id: _, ...x }) => x),
    senderLine: fillPlaceholders(layout.senderLine, values),
    recipient: doc.recipient ? [doc.recipient.name, ...doc.recipient.lines] : [],
    info,
    footer: layout.footer.map((c) => fillPlaceholders(c, values)).filter((c) => c.trim() !== ''),
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
      closing: doc.closingText,
    },
  }
}
