import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { documentLetter, renderLetterPdf } from '@easybau/pdf-templates'
import { describe, expect, it } from 'vitest'
import { invoice, standardItems, UNIT_CODES } from './fixtures.test-support.js'
import { addFacturXMetadata, buildEinvoice, FacturXError, facturXmp } from './index.js'

const has = (tool: string) => {
  try {
    execFileSync(tool, ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('ZUGFeRD / Factur-X PDF/A-3', () => {
  const doc = invoice(standardItems())
  const xml = buildEinvoice(doc, { unitCodes: UNIT_CODES }, 'zugferd').xml
  const { logoPosition: _, ...letter } = documentLetter(doc, { watermark: null })
  const plain = renderLetterPdf(
    { ...letter, logo: null },
    { createdAt: new Date('2026-11-21T10:00:00Z'), einvoiceXml: Buffer.from(xml) },
  )
  const pdf = addFacturXMetadata(plain, 'EN 16931')

  it('attaches factur-x.xml and adds the Factur-X XMP in an incremental update', () => {
    // Original bytes unchanged, update appended.
    expect(pdf.subarray(0, plain.length).equals(plain)).toBe(true)
    const text = pdf.toString('latin1')
    expect(text).toContain('/AFRelationship /Alternative')
    expect(text).toContain('/F (factur-x.xml)')
    const update = text.slice(plain.length)
    expect(update).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>')
    expect(update).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>')
    expect(update).toContain('<pdfaSchema:prefix>fx</pdfaSchema:prefix>')
    expect(update).toMatch(/\/Prev \d+/)
    // startxref of the update points at its xref section; /Length matches the stream.
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
    const length = Number(/\/Length (\d+)\n {2}\/Type \/Metadata/.exec(update)?.[1])
    const stream = pdf.subarray(plain.length).toString('latin1')
    const begin = stream.indexOf('stream\n') + 7
    expect(Buffer.from(stream.slice(begin, stream.indexOf('\nendstream')), 'latin1').length).toBe(
      length,
    )
    if (process.env.PDF_SAMPLE_DIR) {
      mkdirSync(process.env.PDF_SAMPLE_DIR, { recursive: true })
      writeFileSync(join(process.env.PDF_SAMPLE_DIR, 'zugferd.pdf'), pdf)
    }
  })

  it.skipIf(!has('pdfinfo') || !has('pdfdetach'))(
    'stays readable and exposes metadata and attachment',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'easybau-zugferd-'))
      const file = join(dir, 'r.pdf')
      writeFileSync(file, pdf)
      const meta = execFileSync('pdfinfo', ['-meta', file]).toString()
      expect(meta).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>')
      expect(meta).toContain('<pdfaid:part>3</pdfaid:part>')
      expect(execFileSync('pdfdetach', ['-list', file]).toString()).toContain('factur-x.xml')
      execFileSync('pdfdetach', ['-save', '1', '-o', join(dir, 'x.xml'), file])
      expect(execFileSync('cat', [join(dir, 'x.xml')]).toString()).toBe(xml)
    },
  )

  it('updates the document XMP, not the XMP of an embedded JPEG logo', () => {
    // 8×8 JPEG with an ordinary (Adobe-style) XMP packet in its APP1 segment.
    const jpeg = Buffer.from(
      '/9j/4QFqaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLwA8P3hwYWNrZXQgYmVnaW49IiIgaWQ9Ilc1TTBNcENlaG' +
        'lIenJlU3pOVGN6a2M5ZCI/Pjx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iPjxyZGY6UkRGIHhtbG5z' +
        'OnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+PHJkZjpEZXNjcmlwdGlvbi' +
        'ByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIj48eG1wOkNyZWF0b3JU' +
        'b29sPkFkb2JlIFBob3Rvc2hvcDwveG1wOkNyZWF0b3JUb29sPjwvcmRmOkRlc2NyaXB0aW9uPjwvcmRmOlJERj48L3' +
        'g6eG1wbWV0YT48P3hwYWNrZXQgZW5kPSJ3Ij8+/+AAEEpGSUYAAQEAAAEAAQAA/9sAQwAIBgYHBgUIBwcHCQkICgwU' +
        'DQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ0YMiEcIT' +
        'IyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgAFAAoAwEiAAIRAQMR' +
        'Af/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBh' +
        'NRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp' +
        'anN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5e' +
        'bn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAEC' +
        'dwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSl' +
        'NUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJ' +
        'ytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A5CiiivFP0wKKKKACiiigAooooAKKKKACii' +
        'igD//Z',
      'base64',
    )
    const withLogo = renderLetterPdf(
      {
        ...letter,
        logo: { x: 25, y: 10, width: 30, maxHeight: 20, data: jpeg, mime: 'image/jpeg' },
      },
      { createdAt: new Date('2026-11-21T10:00:00Z'), einvoiceXml: Buffer.from(xml) },
    )
    const text = withLogo.toString('latin1')
    expect(text.indexOf('<?xpacket begin')).toBeLessThan(text.lastIndexOf('<?xpacket begin'))
    const update = addFacturXMetadata(withLogo, 'EN 16931')
      .subarray(withLogo.length)
      .toString('utf8')
    expect(update).toContain('<pdfaid:part>3</pdfaid:part>')
    expect(update).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>')
    expect(update).not.toContain('Photoshop')
  })

  it('refuses PDFs it cannot update safely', () => {
    expect(() => addFacturXMetadata(Buffer.from('%PDF-1.7\n'))).toThrow(FacturXError)
    expect(() => facturXmp('<x/>', 'EN 16931')).toThrow(FacturXError)
  })
})
