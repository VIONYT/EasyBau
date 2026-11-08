import { RESULT_DECIMALS, roundTo } from '@opc/domain'
/** Date formatting that never throws on unexpected input (a crash would blank the whole app). */
export function formatDateTime(
  iso: string | null | undefined,
  style: 'date' | 'datetime' = 'datetime',
): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(
    'de-DE',
    style === 'date' ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' },
  ).format(date)
}

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

/** Amount in cents as „1.234,56 €“ (display only; calculation happens on the server). */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  return euro.format(cents / 100)
}

/** Cents as input value „1234,56“ (no thousands separator, comma as decimal mark). */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  const negative = cents < 0
  const abs = Math.abs(cents)
  const text = `${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`
  return negative ? `-${text}` : text
}

/**
 * Parses a euro amount typed by a person („1.234,56“, „12,5“, „12.50“, „1234“) into cents,
 * exactly and without floating point (rule 1). Returns null for empty input, NaN if invalid.
 */
export function parseEuro(input: string): number | null {
  let text = input.replace(/[\s€]/g, '')
  if (!text) return null
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.')
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '')
  const match = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return Number.NaN
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'))
  return match[1] ? -cents : cents
}

/**
 * Quantities, results and sums for display: rounded half up to two decimals („34.657“ → „34,66“),
 * trailing zeros dropped („12.50“ → „12,5“).
 */
export function formatQuantity(quantity: string | null | undefined): string {
  if (!quantity) return ''
  let rounded: string
  try {
    rounded = roundTo(quantity, RESULT_DECIMALS)
  } catch {
    return quantity
  }
  return formatInputNumber(rounded)
}

/** Numbers as entered (room dimensions like 0,885, form values): no rounding, comma, no trailing zeros. */
export function formatInputNumber(value: string | null | undefined): string {
  if (!value) return ''
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
  return trimmed.replace('.', ',')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toLocaleString('de-DE', { maximumFractionDigits: 0 })} KB`
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`
}
