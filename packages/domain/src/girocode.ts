/**
 * GiroCode / EPC-QR (European Payments Council, EPC069-12, version 002): SEPA credit transfer data
 * a banking app reads from the invoice. Returns the text to encode as QR code (error correction M),
 * or null when no valid code can be made (no IBAN, amount out of range).
 */
export interface GiroCodeInput {
  /** Zahlungsempfänger (max. 70 characters). */
  name: string
  iban: string | null
  bic?: string | null
  /** Amount to pay (without Skonto), 0.01 … 999 999 999.99 €. */
  amountCents: bigint
  /** Verwendungszweck, e.g. the invoice number (max. 140 characters). */
  reference: string
}

const MAX_CENTS = 99_999_999_999n
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/

export function giroCodePayload(input: GiroCodeInput): string | null {
  const iban = input.iban?.replace(/\s+/g, '').toUpperCase() ?? ''
  if (!IBAN.test(iban)) return null
  if (input.amountCents <= 0n || input.amountCents > MAX_CENTS) return null
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 70)
  if (!name) return null
  const euros = `${input.amountCents / 100n}.${(input.amountCents % 100n).toString().padStart(2, '0')}`
  return [
    'BCD',
    '002',
    '1', // UTF-8
    'SCT',
    input.bic?.replace(/\s+/g, '').toUpperCase() ?? '',
    name,
    iban,
    `EUR${euros}`,
    '', // purpose code
    '', // structured creditor reference
    input.reference.replace(/\s+/g, ' ').trim().slice(0, 140),
  ].join('\n')
}
