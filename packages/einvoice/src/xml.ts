/**
 * Minimal XML writer: every value is escaped, nothing is ever parsed or evaluated. Children that
 * are null/undefined/false/'' are skipped, so optional elements are written with `text()`.
 */
export type XmlNode = string | null | undefined | false | readonly XmlNode[]

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/** Characters not allowed in XML 1.0 (control characters except tab, LF, CR). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

export function escapeXml(value: string): string {
  return value.replace(INVALID, '').replace(/[&<>"']/g, (c) => ESCAPES[c] as string)
}

function flatten(children: readonly XmlNode[]): string {
  let out = ''
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === '') continue
    out += typeof child === 'string' ? child : flatten(child)
  }
  return out
}

function attributes(attrs: Record<string, string | null | undefined> | null): string {
  if (!attrs) return ''
  return Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${escapeXml(v as string)}"`)
    .join('')
}

/** Element with child elements (always written, even when empty). */
export function el(
  name: string,
  attrs: Record<string, string | null | undefined> | null,
  ...children: XmlNode[]
): string {
  return `<${name}${attributes(attrs)}>${flatten(children)}</${name}>`
}

/** Element with escaped text; omitted when the value is empty. */
export function text(
  name: string,
  value: string | number | null | undefined,
  attrs: Record<string, string | null | undefined> | null = null,
): string {
  if (value === null || value === undefined) return ''
  const content = String(value)
  if (!content.trim()) return ''
  return `<${name}${attributes(attrs)}>${escapeXml(content)}</${name}>`
}

/** Writes the child only when the condition holds. */
export const when = (condition: unknown, node: () => XmlNode): XmlNode =>
  condition ? node() : null

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'
