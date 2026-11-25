/**
 * Geldbeträge in Eingabefeldern (DESIGN.md §7.2): German notation „1.234,56“ ↔ cents (rule 1:
 * money is never a float – the input is parsed as a decimal string).
 */
const MONEY = /^-?\d{1,3}(\.\d{3})*(,\d{1,2})?$|^-?\d+(,\d{1,2})?$|^-?\d+(\.\d{1,2})$/

/** „1.234,5“ → 123450n; empty → null; invalid → undefined. */
export function parseEuro(input: string): bigint | null | undefined {
  const text = input.trim().replace(/\s|€/g, '')
  if (!text) return null
  if (!MONEY.test(text)) return undefined
  // A single dot followed by one or two digits is a decimal point (12.5), otherwise thousands.
  const normalized = /^-?\d+\.\d{1,2}$/.test(text)
    ? text
    : text.replace(/\./g, '').replace(',', '.')
  const negative = normalized.startsWith('-')
  const [euros = '0', cents = ''] = normalized.replace('-', '').split('.')
  const value = BigInt(euros) * 100n + BigInt(`${cents}00`.slice(0, 2))
  return negative ? -value : value
}

/** 123450n → „1.234,50“ (for the input, without currency sign). */
export function formatEuroInput(cents: bigint | number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  const value = BigInt(cents)
  const negative = value < 0n
  const abs = negative ? -value : value
  const euros = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const rest = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${euros},${rest}`
}
