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

  it('refuses PDFs it cannot update safely', () => {
    expect(() => addFacturXMetadata(Buffer.from('%PDF-1.7\n'))).toThrow(FacturXError)
    expect(() => facturXmp('<x/>', 'EN 16931')).toThrow(FacturXError)
  })
})
