import { formatEuro, germanDate, giroCodePayload, type LetterheadValues } from '@easybau/domain'
import type { DunningAmounts } from '@easybau/schemas'
import { germanPercent } from './document.js'
import { type LogoPosition, letterFrame } from './frame.js'
import type { LetterPdfInput } from './types.js'

export const DUNNING_TITLE: Record<DunningAmounts['level'], string> = {
  reminder: 'Zahlungserinnerung',
  first: '1. Mahnung',
  final: 'Letzte Mahnung',
}

/**
 * Frozen content of a dunning letter (dunning_notice.letter_snapshot): company frame at the time of
 * issue, recipient of the invoice, the computed amounts and the final text.
 */
export interface DunningLetterSnapshot {
  issuer: {
    name: string
    layout: Parameters<typeof letterFrame>[0]['layout']
    values: LetterheadValues
    iban: string | null
    bic: string | null
  }
  recipient: string[]
  customerNumber: string | null
  invoice: {
    number: string
    title: string
    documentDate: string
    dueDate: string | null
    subject: string | null
    placeOfPerformance: string | null
    grossCents: number
  }
  amounts: Omit<DunningAmounts, 'text'>
  /** Letter text with placeholders filled. */
  text: string
  signer: string | null
}

const euro = (cents: number) => formatEuro(BigInt(cents))
const date = (iso: string) => germanDate(iso)

/** Placeholders of the configurable text: {Rechnung}, {Rechnungsdatum}, {Frist}, {Betrag}. */
export function fillDunningText(
  text: string,
  values: { number: string; documentDate: string; dueDate: string; totalCents: number },
): string {
  const map: Record<string, string> = {
    rechnung: values.number,
    rechnungsdatum: date(values.documentDate),
    frist: date(values.dueDate),
    betrag: euro(values.totalCents),
  }
  return text.replace(/\{([^{}]+)\}/g, (all, key: string) => map[key.trim().toLowerCase()] ?? all)
}

/** Zahlungserinnerung / Mahnung as letter (DIN 5008 B): Aufstellung, deadline, GiroCode. */
export function dunningLetter(
  s: DunningLetterSnapshot,
): Omit<LetterPdfInput, 'logo'> & { logoPosition: LogoPosition | null } {
  const a = s.amounts
  const title = DUNNING_TITLE[a.level]
  const info = [
    { label: 'Datum', value: date(a.noticeDate) },
    { label: 'Rechnung', value: s.invoice.number },
    { label: 'Rechnungsdatum', value: date(s.invoice.documentDate) },
  ]
  if (s.customerNumber) info.push({ label: 'Kundennummer', value: s.customerNumber })
  if (s.signer) info.push({ label: 'Ansprechpartner', value: s.signer })

  const totals: LetterPdfInput['body']['totals'] = [
    {
      label: `${s.invoice.title} ${s.invoice.number} vom ${date(s.invoice.documentDate)}`,
      value: euro(s.invoice.grossCents),
      grand: false,
      note: s.invoice.dueDate ? `fällig seit ${date(s.invoice.dueDate)}` : null,
    },
  ]
  if (a.openCents !== s.invoice.grossCents) {
    totals.push({
      label: 'abzüglich Zahlungen und Abzüge',
      value: `− ${euro(s.invoice.grossCents - a.openCents)}`,
      grand: false,
      note: null,
    })
    totals.push({
      label: 'Offener Rechnungsbetrag',
      value: euro(a.openCents),
      grand: false,
      note: null,
    })
  }
  if (a.earlierChargesCents) {
    totals.push({
      label: 'Mahnkosten aus früheren Schreiben',
      value: euro(a.earlierChargesCents),
      grand: false,
      note: null,
    })
  }
  if (a.feeCents) {
    totals.push({ label: 'Mahngebühr', value: euro(a.feeCents), grand: false, note: null })
  }
  if (a.flatFeeCents) {
    totals.push({
      label: 'Verzugspauschale (§ 288 Abs. 5 BGB)',
      value: euro(a.flatFeeCents),
      grand: false,
      note: null,
    })
  }
  if (a.interestCents && a.interestFrom && a.interestTo) {
    totals.push({
      label: `Verzugszinsen vom ${date(a.interestFrom)} bis ${date(a.interestTo)}`,
      value: euro(a.interestCents),
      grand: false,
      note: `${a.segments
        .map(
          (seg) =>
            `${germanPercent(seg.ratePercent)} % p. a. auf ${euro(seg.principalCents)} für ${seg.days} ${seg.days === 1 ? 'Tag' : 'Tage'} (${date(seg.from)} – ${date(seg.to)})`,
        )
        .join(
          '; ',
        )} – Basiszinssatz + ${a.business ? 9 : 5} Prozentpunkte (§ 288 BGB), ab ${date(addDay(a.noticeDate))} weitere Zinsen`,
    })
  }
  totals.push({ label: 'Zu zahlender Betrag', value: euro(a.totalCents), grand: true, note: null })

  const notes = [
    `Bitte zahlen Sie bis zum ${date(a.dueDate)}.${a.feeCents || a.flatFeeCents || a.interestCents || a.earlierChargesCents ? ' Mahnkosten und Verzugszinsen unterliegen nicht der Umsatzsteuer.' : ''}`,
  ]
  const about = [
    s.invoice.subject,
    s.invoice.placeOfPerformance ? `Leistungsort: ${s.invoice.placeOfPerformance}` : null,
  ].filter((v): v is string => Boolean(v))
  const small = about.length ? [about.join(' · ')] : []

  const reference = `${title} ${s.invoice.number}`
  const payload = giroCodePayload({
    name: s.issuer.name,
    iban: s.issuer.iban,
    bic: s.issuer.bic,
    amountCents: BigInt(a.totalCents),
    reference: s.invoice.number,
  })
  return {
    ...letterFrame({
      issuerName: s.issuer.name,
      layout: s.issuer.layout,
      values: s.issuer.values,
      recipient: s.recipient,
      info,
      title: reference,
      watermark: null,
    }),
    body: {
      heading: title,
      subject: `${s.invoice.title} ${s.invoice.number} vom ${date(s.invoice.documentDate)}`,
      small,
      intro: `Sehr geehrte Damen und Herren,\n\n${s.text}`,
      columns: [],
      items: [],
      deductions: null,
      totals,
      notes,
      paymentQr: payload
        ? {
            payload,
            lines: [
              'Bezahlen mit GiroCode',
              'Mit der Banking-App scannen.',
              `Betrag: ${euro(a.totalCents)}`,
              `Verwendungszweck: ${s.invoice.number}`,
            ],
          }
        : null,
      closing: `Mit freundlichen Grüßen\n${s.issuer.name}`,
      blocks: [],
    },
  }
}

function addDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
