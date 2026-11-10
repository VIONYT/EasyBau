/**
 * Allowed upload types (CLAUDE.md rule 9: check uploads). The extension selects the type,
 * the content (magic number) must match it. Everything else is rejected, so no HTML, SVG or
 * scripts can be uploaded and later be opened from our origin.
 */

export type FileCategory = 'image' | 'pdf' | 'video' | 'office' | 'plan' | 'text' | 'archive'

export interface FileType {
  mime: string
  category: FileCategory
  /** May be shown in the browser (images, PDF, video); everything else is downloaded. */
  inline: boolean
}

type Check = (head: Buffer) => boolean

const startsWith =
  (...bytes: number[]): Check =>
  (head) =>
    head.length >= bytes.length && bytes.every((b, i) => head[i] === b)
const ascii = (text: string, offset = 0): Check => {
  const bytes = Buffer.from(text, 'latin1')
  return (head) =>
    head.length >= offset + bytes.length &&
    head.subarray(offset, offset + bytes.length).equals(bytes)
}
const isoBrand =
  (...brands: string[]): Check =>
  (head) =>
    ascii('ftyp', 4)(head) && brands.includes(head.subarray(8, 12).toString('latin1'))

/** Text without NUL bytes (UTF-8, Latin-1). */
const isText: Check = (head) => head.length > 0 && !head.includes(0)
const isXml: Check = (head) => {
  if (!isText(head)) return false
  const text = head.toString('utf8').replace(/^﻿/, '').trimStart()
  return text.startsWith('<')
}
const isZip = startsWith(0x50, 0x4b, 0x03, 0x04)

const TYPES: Record<string, FileType & { check: Check }> = {
  pdf: { mime: 'application/pdf', category: 'pdf', inline: true, check: ascii('%PDF-') },
  jpg: { mime: 'image/jpeg', category: 'image', inline: true, check: startsWith(0xff, 0xd8, 0xff) },
  png: {
    mime: 'image/png',
    category: 'image',
    inline: true,
    check: startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  },
  gif: {
    mime: 'image/gif',
    category: 'image',
    inline: true,
    check: (h) => ascii('GIF87a')(h) || ascii('GIF89a')(h),
  },
  webp: {
    mime: 'image/webp',
    category: 'image',
    inline: true,
    check: (h) => ascii('RIFF')(h) && ascii('WEBP', 8)(h),
  },
  heic: {
    mime: 'image/heic',
    category: 'image',
    // Most browsers cannot display HEIC; it is downloaded instead.
    inline: false,
    check: isoBrand('heic', 'heix', 'heif', 'mif1', 'msf1', 'hevc'),
  },
  mp4: {
    mime: 'video/mp4',
    category: 'video',
    inline: true,
    check: isoBrand('isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '),
  },
  mov: { mime: 'video/quicktime', category: 'video', inline: true, check: isoBrand('qt  ') },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    category: 'office',
    inline: false,
    check: isZip,
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'office',
    inline: false,
    check: isZip,
  },
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    category: 'office',
    inline: false,
    check: isZip,
  },
  odt: {
    mime: 'application/vnd.oasis.opendocument.text',
    category: 'office',
    inline: false,
    check: isZip,
  },
  ods: {
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    category: 'office',
    inline: false,
    check: isZip,
  },
  zip: { mime: 'application/zip', category: 'archive', inline: false, check: isZip },
  dwg: { mime: 'image/vnd.dwg', category: 'plan', inline: false, check: ascii('AC10') },
  dxf: { mime: 'image/vnd.dxf', category: 'plan', inline: false, check: isText },
  txt: { mime: 'text/plain', category: 'text', inline: false, check: isText },
  csv: { mime: 'text/csv', category: 'text', inline: false, check: isText },
  xml: { mime: 'application/xml', category: 'text', inline: false, check: isXml },
  // GAEB DA XML (Leistungsverzeichnisse): X81–X86, X31 (Mengenermittlung)
  x31: { mime: 'application/xml', category: 'text', inline: false, check: isXml },
  x81: { mime: 'application/xml', category: 'text', inline: false, check: isXml },
  x82: { mime: 'application/xml', category: 'text', inline: false, check: isXml },
  x83: { mime: 'application/xml', category: 'text', inline: false, check: isXml },
  x84: { mime: 'application/xml', category: 'text', inline: false, check: isXml },
  x85: { mime: 'application/xml', category: 'text', inline: false, check: isXml },
  x86: { mime: 'application/xml', category: 'text', inline: false, check: isXml },
}
const ALIASES: Record<string, string> = { jpeg: 'jpg', heif: 'heic', m4v: 'mp4' }

/** File extensions accepted for upload (for the `accept` attribute and error messages). */
export const ALLOWED_EXTENSIONS: readonly string[] = [
  ...Object.keys(TYPES),
  ...Object.keys(ALIASES),
]

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename)
  return match ? (match[1] as string).toLowerCase() : ''
}

/** Detects the file type from extension and content; null if not allowed or not matching. */
export function detectFileType(filename: string, head: Buffer): FileType | null {
  const ext = extensionOf(filename)
  const type = TYPES[ALIASES[ext] ?? ext]
  if (!type?.check(head)) return null
  return { mime: type.mime, category: type.category, inline: type.inline }
}

/**
 * Makes a user-supplied file name safe to store and to send in Content-Disposition:
 * no paths, no control characters, at most 200 characters, never empty.
 */
export function sanitizeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? ''
  const cleaned = [...base]
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code > 0x1f && code !== 0x7f && !'"<>|:*?'.includes(ch)
    })
    .join('')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned) return 'Datei'
  if (cleaned.length <= 200) return cleaned
  const ext = extensionOf(cleaned)
  const keep = ext ? `.${ext}` : ''
  return cleaned.slice(0, 200 - keep.length) + keep
}

/** Category and display mode of a stored MIME type (for listing files). */
export function typeOfMime(mime: string): FileType {
  const type = Object.values(TYPES).find((t) => t.mime === mime)
  return type
    ? { mime: type.mime, category: type.category, inline: type.inline }
    : { mime, category: 'archive', inline: false }
}
