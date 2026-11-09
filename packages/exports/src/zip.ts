import { crc32 } from 'node:zlib'

/**
 * Minimal streaming ZIP writer (method "stored", no compression): entries are written as they
 * come, file contents are streamed through without being held in memory. UTF-8 file names.
 * Archives up to 4 GiB (no ZIP64) – enough for the exports of a small company.
 */

export interface ZipEntry {
  name: string
  /** Content as bytes/text, or a stream of chunks (e.g. a file from the object store). */
  data: Buffer | string | AsyncIterable<Buffer | Uint8Array>
  modified?: Date
}

const MAX = 0xffffffff

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** Removes path tricks from entry names: no absolute paths, no "..", forward slashes only. */
export function safeEntryName(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
  if (!parts.length) throw new Error('empty zip entry name')
  return parts.join('/')
}

export async function* zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): AsyncGenerator<Buffer> {
  const central: Buffer[] = []
  let offset = 0
  let count = 0
  for await (const entry of entries) {
    const name = Buffer.from(safeEntryName(entry.name), 'utf8')
    const { time, date } = dosDateTime(entry.modified ?? new Date())
    // Local header with "data descriptor follows" (bit 3) and UTF-8 names (bit 11).
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0808, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt16LE(name.length, 26)
    yield local
    yield name
    let crc = 0
    let size = 0
    const chunks =
      typeof entry.data === 'string' || Buffer.isBuffer(entry.data)
        ? [Buffer.from(entry.data as string)]
        : (entry.data as AsyncIterable<Buffer | Uint8Array>)
    for await (const chunk of chunks) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      crc = crc32(buffer, crc)
      size += buffer.length
      if (offset + size > MAX) throw new Error('zip archive larger than 4 GiB')
      yield buffer
    }
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crc >>> 0, 4)
    descriptor.writeUInt32LE(size, 8)
    descriptor.writeUInt32LE(size, 12)
    yield descriptor

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0808, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(crc >>> 0, 16)
    header.writeUInt32LE(size, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)
    offset += 30 + name.length + size + 16
    count += 1
    if (count > 0xffff) throw new Error('too many zip entries')
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  yield directory
  yield end
}
