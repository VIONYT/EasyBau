/**
 * Schema eines Nummernkreises, z. B. „R{Jahr}-{Nummer}“ → R2026-00101 oder
 * „R{Nummer}-{Jahr}“ → R00101-2026. The same rules are implemented in SQL (next_number,
 * migration 0016); this module is used for previews and validation.
 *
 * Tokens (case-insensitive):
 *   {Nummer} / {FortlaufendeNummer}  running number, padded with zeros to the minimum length
 *   {Jahr}  four-digit year · {JJ}  two-digit year · {Monat}  two-digit month
 */

export const NUMBER_TOKEN = /\{(nummer|fortlaufendenummer)\}/gi
const YEAR_TOKEN = /\{(jahr|jj)\}/i
const ANY_TOKEN = /\{([^{}]*)\}/g
const KNOWN_TOKENS = new Set(['nummer', 'fortlaufendenummer', 'jahr', 'jj', 'monat'])
/** Literal characters allowed besides the tokens (safe in file names and e-invoices). */
const LITERAL = /^[A-Za-z0-9ÄÖÜäöüß\-_/.# ]*$/

export const NUMBER_PATTERN_MAX_LENGTH = 40

/** Formats a number by its schema. `month` is 1–12. */
export function formatNumber(
  pattern: string,
  value: number | bigint,
  minLength: number,
  date: { year: number; month: number },
): string {
  const running = value.toString().padStart(minLength, '0')
  return pattern
    .replace(NUMBER_TOKEN, running)
    .replace(/\{jahr\}/gi, String(date.year))
    .replace(/\{jj\}/gi, String(date.year % 100).padStart(2, '0'))
    .replace(/\{monat\}/gi, String(date.month).padStart(2, '0'))
}

/** Does the schema contain the year? Required for a yearly restart (else numbers repeat). */
export function patternHasYear(pattern: string): boolean {
  return YEAR_TOKEN.test(pattern)
}

/** Checks a schema; returns a German error message or null if it is valid. */
export function checkNumberPattern(pattern: string): string | null {
  if (pattern.trim() === '') return 'Bitte ein Schema angeben, z. B. R{Jahr}-{Nummer}.'
  if (pattern.length > NUMBER_PATTERN_MAX_LENGTH) {
    return `Das Schema darf höchstens ${NUMBER_PATTERN_MAX_LENGTH} Zeichen lang sein.`
  }
  const running = pattern.match(NUMBER_TOKEN)?.length ?? 0
  if (running !== 1) return 'Das Schema braucht genau einmal {Nummer}.'
  for (const [, token] of pattern.matchAll(ANY_TOKEN)) {
    if (!KNOWN_TOKENS.has((token as string).toLowerCase())) {
      return `Unbekannter Platzhalter {${token}}. Erlaubt: {Jahr}, {JJ}, {Monat}, {Nummer}.`
    }
  }
  const literal = pattern.replace(ANY_TOKEN, '')
  if (literal.includes('{') || literal.includes('}'))
    return 'Bitte Klammern { } nur für Platzhalter verwenden.'
  if (!LITERAL.test(literal)) {
    return 'Erlaubt sind Buchstaben, Ziffern, Leerzeichen und - _ / . #'
  }
  return null
}
