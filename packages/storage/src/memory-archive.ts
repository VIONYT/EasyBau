import type { ArchivedObject, ArchiveStatus, ArchiveStore, RetentionMode } from './archive.js'

/**
 * In-memory archive with Object Lock semantics for tests and local development: like a versioned
 * bucket with Object Lock, a PUT on an existing key adds a new version and keeps every earlier
 * version (nothing is ever overwritten or deleted); reads return the newest version.
 */
export class MemoryArchiveStore implements ArchiveStore {
  readonly bucket = 'memory-archive'
  readonly mode: RetentionMode = 'COMPLIANCE'
  /** Newest version per key (tests may replace one to simulate damage). */
  readonly objects = new Map<string, { data: Buffer; sha256: string; retainUntil: Date }>()
  /** Every version ever written, oldest first. */
  readonly versions = new Map<string, { data: Buffer; sha256: string; retainUntil: Date }[]>()

  async status(): Promise<ArchiveStatus> {
    return { reachable: true, bucketExists: true, objectLock: true, error: null }
  }

  async ensureBucket(): Promise<void> {}

  async put(
    key: string,
    data: Buffer,
    options: { sha256: Buffer; contentType: string; retainUntil: Date },
  ): Promise<{ versionId: string | null }> {
    const version = {
      data: Buffer.from(data),
      sha256: options.sha256.toString('hex'),
      retainUntil: options.retainUntil,
    }
    const all = this.versions.get(key) ?? []
    all.push(version)
    this.versions.set(key, all)
    this.objects.set(key, version)
    return { versionId: `${key}#v${all.length}` }
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

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort()
  }
}
