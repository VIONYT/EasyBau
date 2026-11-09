import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import type { LetterPdfInput } from './types.js'

/** Package root (works from src/ during development and dist/ when built). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FONTS = ['Inter-Regular.otf', 'Inter-Bold.otf', 'DejaVuSerif.ttf', 'DejaVuSerif-Bold.ttf']

let compiler: NodeCompiler | null = null
let template: string | null = null

/** One compiler per process; fonts are loaded from the package, never from the system. */
function getCompiler(): NodeCompiler {
  if (!compiler) {
    compiler = NodeCompiler.create({
      workspace: '/',
      fontArgs: [{ fontBlobs: FONTS.map((f) => readFileSync(join(ROOT, 'fonts', f))) }],
    })
    template = readFileSync(join(ROOT, 'templates', 'letter.typ'), 'utf8')
  }
  return compiler
}

export class PdfRenderError extends Error {
  override name = 'PdfRenderError'
}

const LOGO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * Renders a letter (DIN 5008 Form B, A4) as PDF/A-3b: all fonts embedded, XMP metadata,
 * tagged; PDF/A-3 allows the e-invoice XML to be attached later (ZUGFeRD).
 */
export function renderLetterPdf(
  input: Omit<LetterPdfInput, 'logo'> & {
    logo:
      | (Omit<NonNullable<LetterPdfInput['logo']>, 'path'> & { data: Buffer; mime: string })
      | null
  },
  options: { createdAt?: Date } = {},
): Buffer {
  const typst = getCompiler()
  const { logo, ...rest } = input
  let data: LetterPdfInput = { ...rest, logo: null }
  if (logo) {
    const extension = LOGO_EXTENSION[logo.mime]
    if (!extension) throw new PdfRenderError(`unsupported logo type ${logo.mime}`)
    const path = `/logo.${extension}`
    typst.mapShadow(path, logo.data)
    const { data: _, mime: __, ...position } = logo
    data = { ...data, logo: { ...position, path } }
  }
  typst.mapShadow('/data.json', Buffer.from(JSON.stringify(data)))
  try {
    return typst.pdf(
      { mainFileContent: template as string },
      {
        pdfStandard: 'a-3b',
        ...(options.createdAt
          ? { creationTimestamp: Math.floor(options.createdAt.getTime() / 1000) }
          : {}),
      },
    )
  } catch (error) {
    const diagnostics = (error as { shortDiagnostics?: unknown[] }).shortDiagnostics
    throw new PdfRenderError(
      `Typst: ${diagnostics ? JSON.stringify(diagnostics) : String((error as Error).message)}`,
    )
  } finally {
    typst.resetShadow()
    typst.evictCache(10)
  }
}
