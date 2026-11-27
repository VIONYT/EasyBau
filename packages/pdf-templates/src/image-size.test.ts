import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { imageDimensions, MAX_IMAGE_PIXELS, withinPixelBudget } from './image-size.js'
import { isUsableImage } from './render.js'

/** Minimal valid PNG (8-bit grey) of the given size; rows are empty, so it compresses well. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // greyscale
  // Small images get all rows; for the bomb only the header matters (never decoded).
  const raw = Buffer.alloc((width + 1) * (height <= 1000 ? height : 2))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('image size from the header', () => {
  it('reads PNG, GIF, WebP and JPEG dimensions without decoding', () => {
    expect(imageDimensions(png(320, 200))).toEqual({ width: 320, height: 200 })
    const gif = Buffer.from('GIF89a\x40\x01\xc8\x00\x00\x00\x00', 'latin1')
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 200 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'latin1')
    webp.write('WEBPVP8X', 8, 'latin1')
    webp.writeUIntLE(4000 - 1, 24, 3)
    webp.writeUIntLE(3000 - 1, 27, 3)
    expect(imageDimensions(webp)).toEqual({ width: 4000, height: 3000 })
    // JPEG: APP0 segment, then SOF0 with height 600 and width 800.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58,
      0x03, 0x20, 0x03,
    ])
    expect(imageDimensions(jpeg)).toEqual({ width: 800, height: 600 })
    expect(imageDimensions(Buffer.from('not an image'))).toBeNull()
  })

  it('refuses decompression bombs before Typst decodes them', () => {
    expect(withinPixelBudget(png(8000, 6000))).toBe(true)
    expect(8000 * 6000).toBeLessThanOrEqual(MAX_IMAGE_PIXELS)
    const bomb = png(16000, 16000)
    expect(bomb.length).toBeLessThan(4096)
    expect(withinPixelBudget(bomb)).toBe(false)
    const started = performance.now()
    expect(isUsableImage('/photo-1.png', bomb)).toBe(false)
    expect(performance.now() - started).toBeLessThan(200)
    expect(isUsableImage('/photo-2.png', png(64, 64))).toBe(true)
  })
})
