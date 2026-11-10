import type { ArchivedObject, ArchiveStatus, ArchiveStore, RetentionMode } from './archive.js'

/**
 * In-memory archive with Object Lock semantics for tests and local development: objects cannot be
 * overwritten with different content and are never deleted.
 */
export class MemoryArchiveStore implements ArchiveStore {
  readonly bucket = 'memory-archive'
  readonly mode: RetentionMode = 'COMPLIANCE'
  readonly objects = new Map<string, { data: Buffer; sha256: string; retainUntil: Date }>()

  async status(): Promise<ArchiveStatus> {
    return { reachable: true, bucketExists: true, objectLock: true, error: null }
  }

  async ensureBucket(): Promise<void> {}

  async put(
    key: string,
    data: Buffer,
    options: { sha256: Buffer; contentType: string; retainUntil: Date },
  ): Promise<{ versionId: string | null }> {
    const existing = this.objects.get(key)
    if (existing && existing.sha256 !== options.sha256.toString('hex')) {
      throw new Error(`object ${key} is WORM protected`)
    }
    this.objects.set(key, {
      data: Buffer.from(data),
      sha256: options.sha256.toString('hex'),
      retainUntil: options.retainUntil,
    })
    return { versionId: `v${this.objects.size}` }
  }

  async get(key: string): Promise<Buffer | null> {
    const object = this.objects.get(key)
    return object ? Buffer.from(object.data) : null
  }

  async head(key: string): Promise<ArchivedObject | null> {
    const object = this.objects.get(key)
    return object
      ? {
          sizeBytes: object.data.length,
          retainUntil: object.retainUntil.toISOString(),
          mode: this.mode,
          versionId: null,
          sha256: object.sha256,
        }
      : null
  }
}
