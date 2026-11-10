import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import type { LetterAsset, LetterPdfInput } from './types.js'

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

/**
 * Can Typst decode this image? Photos from the Ablage may be damaged or in a format the PDF
 * cannot embed; such photos are left out instead of failing the whole document.
 */
export function isUsableImage(path: string, data: Buffer): boolean {
  if (!/^\/[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(path)) return false
  const typst = getCompiler()
  typst.mapShadow(path, data)
  try {
    const compiled = typst.compile({ mainFileContent: `#image("${path}", width: 1cm)` })
    const error = compiled.takeError()
    return !error && compiled.result !== null
  } catch {
    return false
  } finally {
    typst.resetShadow()
  }
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
  options: { createdAt?: Date; assets?: LetterAsset[] } = {},
): Buffer {
  const typst = getCompiler()
  for (const asset of options.assets ?? []) typst.mapShadow(asset.path, asset.data)
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
    const compiled = typst.compile({ mainFileContent: template as string })
    const error = compiled.takeError()
    if (error) {
      const messages = typst
        .fetchDiagnostics(error)
        .map((d: { message?: string; range?: string }) =>
          `${d.message ?? ''} ${d.range ?? ''}`.trim(),
        )
      throw new PdfRenderError(`Typst: ${messages.join('; ') || error.compilationStatus}`)
    }
    return typst.pdf(compiled.result as never, {
      pdfStandard: 'a-3b',
      ...(options.createdAt
        ? { creationTimestamp: Math.floor(options.createdAt.getTime() / 1000) }
        : {}),
    })
  } catch (error) {
    if (error instanceof PdfRenderError) throw error
    throw new PdfRenderError(`Typst: ${String((error as Error).message)}`)
  } finally {
    typst.resetShadow()
    typst.evictCache(10)
  }
}
