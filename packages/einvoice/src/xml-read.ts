/**
 * Minimal, safe XML reader for received e-invoices (untrusted input). It builds a small element
 * tree and nothing else: no DTD, no external or custom entities (a DOCTYPE is rejected, which rules
 * out XXE and entity expansion), limits for depth and element count. Names are matched by their
 * local part, so any namespace prefix works.
 */

export interface XmlElement {
  /** Local name without prefix, e.g. "CrossIndustryInvoice". */
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
  /** Concatenated text content of this element (not of its children). */
  text: string
}

export class XmlReadError extends Error {
  override name = 'XmlReadError'
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(value: string): string {
  return value.replace(/&([^;\s&]{1,12});/g, (_, entity: string) => {
    if (entity in ENTITIES) return ENTITIES[entity] as string
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith('#')
        ? Number.parseInt(entity.slice(1), 10)
        : Number.NaN
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) {
      throw new XmlReadError(`Unbekannte Entität &${entity};`)
    }
    return String.fromCodePoint(code)
  })
}

const localName = (qname: string) => qname.slice(qname.indexOf(':') + 1)

const NAME = /^[^\s/>=]+/
const ATTRIBUTE = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y

export interface XmlReadOptions {
  maxDepth?: number
  maxElements?: number
}

/** Parses an XML document and returns its root element. */
export function readXml(source: string, options: XmlReadOptions = {}): XmlElement {
  const maxDepth = options.maxDepth ?? 64
  const maxElements = options.maxElements ?? 200_000
  const xml = source.replace(/^﻿/, '')
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  let elements = 0
  let pos = 0

  const appendText = (text: string) => {
    const current = stack.at(-1)
    if (current) current.text += text
    else if (text.trim()) throw new XmlReadError('Text außerhalb des Wurzelelements.')
  }

  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos)
    if (lt < 0) {
      appendText(decode(xml.slice(pos)))
      break
    }
    if (lt > pos) appendText(decode(xml.slice(pos, lt)))
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end < 0) throw new XmlReadError('Kommentar nicht beendet.')
      pos = end + 3
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      if (end < 0) throw new XmlReadError('CDATA nicht beendet.')
      appendText(xml.slice(lt + 9, end))
      pos = end + 3
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      if (end < 0) throw new XmlReadError('Verarbeitungsanweisung nicht beendet.')
      pos = end + 2
    } else if (xml.startsWith('<!', lt)) {
      // DOCTYPE/ENTITY declarations are never processed (XXE, entity expansion).
      throw new XmlReadError('XML mit DOCTYPE oder Entitätsdeklaration wird nicht angenommen.')
    } else if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt + 2)
      if (end < 0) throw new XmlReadError('Endtag nicht beendet.')
      const name = localName(xml.slice(lt + 2, end).trim())
      const open = stack.pop()
      if (!open || open.name !== name) throw new XmlReadError(`Unerwartetes Endtag </${name}>.`)
      pos = end + 1
    } else {
      const nameMatch = NAME.exec(xml.slice(lt + 1, lt + 200))
      if (!nameMatch) throw new XmlReadError('Ungültiges Starttag.')
      const element: XmlElement = {
        name: localName(nameMatch[0]),
        attrs: {},
        children: [],
        text: '',
      }
      let cursor = lt + 1 + nameMatch[0].length
      for (;;) {
        ATTRIBUTE.lastIndex = cursor
        const attr = ATTRIBUTE.exec(xml)
        if (!attr) break
        element.attrs[localName(attr[1] as string)] = decode(attr[3] ?? attr[4] ?? '')
        cursor = ATTRIBUTE.lastIndex
      }
      while (/\s/.test(xml[cursor] ?? '')) cursor++
      const selfClosing = xml.startsWith('/>', cursor)
      if (!selfClosing && xml[cursor] !== '>') throw new XmlReadError('Ungültiges Starttag.')
      pos = cursor + (selfClosing ? 2 : 1)

      if (++elements > maxElements) throw new XmlReadError('Das XML ist zu groß.')
      const parent = stack.at(-1)
      if (parent) parent.children.push(element)
      else if (root) throw new XmlReadError('Mehr als ein Wurzelelement.')
      else root = element
      if (!selfClosing) {
        if (stack.length >= maxDepth) throw new XmlReadError('Das XML ist zu tief verschachtelt.')
        stack.push(element)
      }
    }
  }
  if (stack.length) throw new XmlReadError(`Element <${stack.at(-1)?.name}> nicht beendet.`)
  if (!root) throw new XmlReadError('Kein XML-Element gefunden.')
  return root
}

/** First descendant along a path of local names, e.g. child(el, 'SellerTradeParty', 'Name'). */
export function child(
  element: XmlElement | null | undefined,
  ...path: string[]
): XmlElement | null {
  let current: XmlElement | null = element ?? null
  for (const name of path) {
    if (!current) return null
    current = current.children.find((c) => c.name === name) ?? null
  }
  return current
}

/** All direct children with a local name. */
export function childrenOf(element: XmlElement | null | undefined, name: string): XmlElement[] {
  return element ? element.children.filter((c) => c.name === name) : []
}

/** Trimmed text along a path, null when missing or empty. */
export function textAt(element: XmlElement | null | undefined, ...path: string[]): string | null {
  const value = child(element, ...path)?.text.trim()
  return value ? value : null
}
