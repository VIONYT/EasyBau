/**
 * Dateinamen-Muster (P2.11): name of downloaded PDFs and e-mail attachments, e.g.
 * "{Typ}_{Nummer}_{Kunde}" → "Rechnung_R2026-00101_Mustermann.pdf" (default "{Typ}_{Nummer}"). Plain text replacement,
 * nothing is evaluated; characters not allowed in file names are removed.
 */

export const FILE_NAME_PLACEHOLDERS = [
  'Typ',
  'Nummer',
  'Kunde',
  'Projekt',
  'Datum',
  'Jahr',
] as const
export type FileNamePlaceholder = (typeof FILE_NAME_PLACEHOLDERS)[number]

export const DEFAULT_FILE_NAME_PATTERN = '{Typ}_{Nummer}'
const MAX_LENGTH = 120

/** German error message for an invalid pattern, or null. */
export function checkFileNamePattern(pattern: string): string | null {
  if (!pattern.trim()) return 'Das Muster ist leer.'
  if (pattern.length > 200) return 'Das Muster ist zu lang (höchstens 200 Zeichen).'
  const unknown = [...pattern.matchAll(/\{([^}]*)\}/g)]
    .map((m) => m[1] as string)
    .filter((name) => !(FILE_NAME_PLACEHOLDERS as readonly string[]).includes(name))
  if (unknown.length) return `Unbekannter Platzhalter: {${unknown[0]}}.`
  if (!pattern.includes('{Nummer}') && !pattern.includes('{Typ}')) {
    return 'Das Muster braucht {Nummer} oder {Typ}, damit die Dateien unterscheidbar sind.'
  }
  return null
}

/** Removes characters that are not allowed or risky in file names (Windows, macOS, e-mail). */
function clean(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are removed on purpose
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '')
      .replace(/\s+/g, '_')
  )
}

/**
 * File name from the pattern; missing values leave no doubled separators. `extension` without
 * dot ("pdf"). Falls back to "Dokument" when nothing is left.
 */
export function fileNameFrom(
  pattern: string,
  values: Partial<Record<FileNamePlaceholder, string | null>>,
  extension: string,
): string {
  const filled = pattern.replace(/\{([^}]*)\}/g, (_, name: string) =>
    clean(values[name as FileNamePlaceholder] ?? ''),
  )
  const base = clean(filled)
    .replace(/[_\-.]{2,}/g, (m) => m[0] as string)
    .replace(/^[_\-. ]+|[_\-. ]+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/[_\-. ]+$/g, '')
  return `${base || 'Dokument'}.${extension}`
}
