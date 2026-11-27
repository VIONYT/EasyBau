/**
 * Pixel dimensions from the image header, without decoding (PNG, JPEG, GIF, WebP). Used to refuse
 * images whose decoded raster would not fit into memory: a highly compressed 1 MB PNG can declare
 * 16000 × 16000 pixels and needs about 1 GB once decoded (security audit run-1).
 */
export function imageDimensions(data: Buffer): { width: number; height: number } | null {
  // PNG: signature, then the IHDR chunk with width and height (big endian).
  if (
    data.length >= 24 &&
    data.readUInt32BE(0) === 0x89504e47 &&
    data.toString('latin1', 12, 16) === 'IHDR'
  ) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  // GIF: logical screen size (little endian).
  if (data.length >= 10 && data.toString('latin1', 0, 3) === 'GIF') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
  }
  // WebP: RIFF container with a VP8, VP8L or VP8X chunk.
  if (
    data.length >= 30 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const chunk = data.toString('latin1', 12, 16)
    if (chunk === 'VP8 ') {
      return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L') {
      const bits = data.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') {
      return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
    }
    return null
  }
  // JPEG: walk the segments up to the first start-of-frame marker.
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let at = 2
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) return null
      const marker = data[at + 1] as number
      if (marker === 0xff) {
        at += 1
        continue
      }
      const length = data.readUInt16BE(at + 2)
      const startOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (startOfFrame) {
        return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) }
      }
      if (length < 2) return null
      at += 2 + length
    }
  }
  return null
}

/** Largest image accepted for a PDF: 50 megapixels (current phone cameras stay below). */
export const MAX_IMAGE_PIXELS = 50_000_000

export function withinPixelBudget(data: Buffer): boolean {
  const size = imageDimensions(data)
  return (
    size !== null &&
    size.width > 0 &&
    size.height > 0 &&
    size.width * size.height <= MAX_IMAGE_PIXELS
  )
}
