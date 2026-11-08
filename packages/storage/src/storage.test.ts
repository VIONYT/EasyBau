import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ALLOWED_EXTENSIONS,
  assertValidKey,
  detectFileType,
  extensionOf,
  FsObjectStore,
  sanitizeFilename,
  TooLargeError,
  typeOfMime,
} from './index.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])

describe('detectFileType', () => {
  it('accepts allowed types whose content matches the extension', () => {
    expect(detectFileType('Foto.JPG', JPEG)).toEqual({
      mime: 'image/jpeg',
      category: 'image',
      inline: true,
    })
    expect(detectFileType('plan.jpeg', JPEG)?.mime).toBe('image/jpeg')
    expect(detectFileType('a.png', PNG)?.mime).toBe('image/png')
    expect(detectFileType('a.pdf', Buffer.from('%PDF-1.7\n'))?.category).toBe('pdf')
    expect(detectFileType('a.gif', Buffer.from('GIF89a..'))?.mime).toBe('image/gif')
    expect(detectFileType('a.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime).toBe('image/webp')
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic')])
    expect(detectFileType('IMG_1.HEIC', heic)).toMatchObject({ mime: 'image/heic', inline: false })
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')])
    expect(detectFileType('video.mp4', mp4)?.category).toBe('video')
    expect(detectFileType('a.xlsx', Buffer.from('PK\x03\x04....'))?.category).toBe('office')
    expect(detectFileType('plan.dwg', Buffer.from('AC1032'))?.category).toBe('plan')
    expect(detectFileType('lv.x83', Buffer.from('\uFEFF  <?xml version="1.0"?>'))?.mime).toBe(
      'application/xml',
    )
    expect(detectFileType('notiz.txt', Buffer.from('Hallo Baustelle'))?.mime).toBe('text/plain')
  })

  it('rejects unknown extensions, mismatching content and dangerous types', () => {
    expect(detectFileType('a.png', JPEG)).toBeNull()
    expect(detectFileType('evil.pdf', Buffer.from('<html>'))).toBeNull()
    expect(detectFileType('page.html', Buffer.from('<html>'))).toBeNull()
    expect(detectFileType('icon.svg', Buffer.from('<svg>'))).toBeNull()
    expect(detectFileType('run.exe', Buffer.from('MZ'))).toBeNull()
    expect(detectFileType('noext', PNG)).toBeNull()
    expect(detectFileType('a.txt', Buffer.from([0x41, 0x00, 0x42]))).toBeNull()
    expect(detectFileType('a.txt', Buffer.alloc(0))).toBeNull()
    expect(detectFileType('a.xml', Buffer.from('kein xml'))).toBeNull()
    expect(detectFileType('a.xml', Buffer.from([0x3c, 0x00]))).toBeNull()
  })

  it('reads extensions', () => {
    expect(extensionOf('a.tar.GZ')).toBe('gz')
    expect(extensionOf('README')).toBe('')
  })
})

describe('sanitizeFilename', () => {
  it('removes paths, control characters and reserved characters', () => {
    expect(sanitizeFilename('C:\\Users\\x\\Grundriss EG.pdf')).toBe('Grundriss EG.pdf')
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('a\u0000b"c<d>.png')).toBe('abcd.png')
    expect(sanitizeFilename('...hidden')).toBe('hidden')
    expect(sanitizeFilename('   ')).toBe('Datei')
  })

  it('shortens long names but keeps the extension', () => {
    const name = sanitizeFilename(`${'x'.repeat(300)}.pdf`)
    expect(name).toHaveLength(200)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(sanitizeFilename('y'.repeat(300))).toHaveLength(200)
  })
})

describe('FsObjectStore', () => {
  const dirs: string[] = []
  const store = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opc-store-'))
    dirs.push(dir)
    return { dir, store: new FsObjectStore(dir) }
  }
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  it('receives, hashes, commits, reads and deletes objects', async () => {
    const { store: s } = await store()
    const content = Buffer.concat([PNG, Buffer.alloc(10_000, 7)])
    const pending = await s.receive(
      Readable.from([content.subarray(0, 5000), content.subarray(5000)]),
      {
        maxBytes: 1_000_000,
      },
    )
    expect(pending.sizeBytes).toBe(content.length)
    expect(pending.head).toHaveLength(4096)
    expect(pending.head.subarray(0, 8)).toEqual(PNG.subarray(0, 8))
    expect(pending.sha256.toString('hex')).toBe(
      (await import('node:crypto')).createHash('sha256').update(content).digest('hex'),
    )
    await pending.commit('t1/files/abc')
    await pending.discard()
    expect(await s.size('t1/files/abc')).toBe(content.length)
    const chunks: Buffer[] = []
    for await (const chunk of s.read('t1/files/abc')) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).equals(content)).toBe(true)
    await s.delete('t1/files/abc')
    expect(await s.size('t1/files/abc')).toBeNull()
  })

  it('aborts uploads above the limit and leaves no temporary files', async () => {
    const { dir, store: s } = await store()
    await expect(
      s.receive(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), { maxBytes: 1000 }),
    ).rejects.toBeInstanceOf(TooLargeError)
    expect(await readdir(join(dir, 'tmp'))).toEqual([])
  })

  it('discards pending objects', async () => {
    const { dir, store: s } = await store()
    const pending = await s.receive(Readable.from([Buffer.from('abc')]), { maxBytes: 10 })
    await pending.discard()
    expect(await readdir(join(dir, 'tmp'))).toEqual([])
  })

  it('only accepts server-generated keys', () => {
    expect(() => assertValidKey('a/b-c_d/0')).not.toThrow()
    for (const key of ['../x', '/abs', 'a//b', 'A/b', 'a/../b', '', 'a/b/']) {
      expect(() => assertValidKey(key)).toThrow(/invalid storage key/)
    }
    expect(() => new FsObjectStore('/tmp').read('../etc')).toThrow()
  })
})

describe('typeOfMime', () => {
  it('maps stored MIME types back to category and display mode', () => {
    expect(typeOfMime('image/png')).toEqual({ mime: 'image/png', category: 'image', inline: true })
    expect(typeOfMime('application/pdf').inline).toBe(true)
    expect(typeOfMime('application/x-unknown')).toEqual({
      mime: 'application/x-unknown',
      category: 'archive',
      inline: false,
    })
  })

  it('accepts exactly the extensions announced to the web app', async () => {
    const { UPLOAD_EXTENSIONS } = await import('@opc/schemas')
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual([...UPLOAD_EXTENSIONS].sort())
  })
})
