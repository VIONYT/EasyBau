import { createHash } from 'node:crypto'
import { S3Client, type S3Config, S3Error } from './s3.js'

/** Object Lock retention mode: COMPLIANCE cannot be shortened by anyone, not even an admin. */
export type RetentionMode = 'COMPLIANCE' | 'GOVERNANCE'

export interface ArchivedObject {
  sizeBytes: number
  retainUntil: string | null
  mode: string | null
  versionId: string | null
  /** SHA-256 (hex) stored as metadata at upload. */
  sha256: string | null
}

export interface ArchiveStatus {
  reachable: boolean
  bucketExists: boolean
  objectLock: boolean
  error: string | null
}

/**
 * Revisionssicheres Belegarchiv (WORM, ADR 0008): originals of finalized documents are written
 * once with a retention date; until then nobody can change or delete them.
 */
export interface ArchiveStore {
  readonly bucket: string
  readonly mode: RetentionMode
  status(): Promise<ArchiveStatus>
  /** Creates the bucket with Object Lock if missing (development, tests); never changes an existing one. */
  ensureBucket(): Promise<void>
  put(
    key: string,
    data: Buffer,
    options: { sha256: Buffer; contentType: string; retainUntil: Date },
  ): Promise<{ versionId: string | null }>
  get(key: string): Promise<Buffer | null>
  head(key: string): Promise<ArchivedObject | null>
}

export class ArchiveError extends Error {
  override name = 'ArchiveError'
}

export class S3ArchiveStore implements ArchiveStore {
  private readonly client: S3Client
  readonly bucket: string

  constructor(
    config: S3Config,
    readonly mode: RetentionMode = 'COMPLIANCE',
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new S3Client(config, fetchImpl)
    this.bucket = config.bucket
  }

  async status(): Promise<ArchiveStatus> {
    try {
      // HeadBucket first: some servers report a missing lock configuration for missing buckets.
      const bucket = await this.client.request({ method: 'HEAD', allow: [404] })
      if (bucket.status === 404) {
        return { reachable: true, bucketExists: false, objectLock: false, error: 'NoSuchBucket' }
      }
      const response = await this.client.request({
        method: 'GET',
        query: { 'object-lock': '' },
        allow: [404],
      })
      const text = await response.text()
      if (response.status === 404) {
        const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? null
        return { reachable: true, bucketExists: true, objectLock: false, error: code }
      }
      return {
        reachable: true,
        bucketExists: true,
        objectLock: /<ObjectLockEnabled>Enabled<\/ObjectLockEnabled>/.test(text),
        error: null,
      }
    } catch (error) {
      if (error instanceof S3Error) {
        return { reachable: true, bucketExists: false, objectLock: false, error: error.code }
      }
      return {
        reachable: false,
        bucketExists: false,
        objectLock: false,
        error: String((error as Error).message),
      }
    }
  }

  async ensureBucket(): Promise<void> {
    const current = await this.status()
    if (!current.reachable) throw new ArchiveError(`archive not reachable: ${current.error}`)
    if (current.bucketExists) return
    const region = this.client.config.region
    const body =
      region && region !== 'us-east-1'
        ? Buffer.from(
            `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`,
          )
        : undefined
    await this.client.request({
      method: 'PUT',
      headers: { 'x-amz-bucket-object-lock-enabled': 'true' },
      ...(body ? { body } : {}),
      allow: [409],
    })
  }

  async put(
    key: string,
    data: Buffer,
    options: { sha256: Buffer; contentType: string; retainUntil: Date },
  ): Promise<{ versionId: string | null }> {
    const actual = createHash('sha256').update(data).digest()
    if (!actual.equals(options.sha256)) {
      throw new ArchiveError(`checksum mismatch for ${key}`)
    }
    const response = await this.client.request({
      method: 'PUT',
      key,
      body: data,
      headers: {
        'content-type': options.contentType,
        'content-md5': createHash('md5').update(data).digest('base64'),
        'x-amz-checksum-sha256': options.sha256.toString('base64'),
        'x-amz-meta-sha256': options.sha256.toString('hex'),
        'x-amz-object-lock-mode': this.mode,
        'x-amz-object-lock-retain-until-date': options.retainUntil.toISOString(),
      },
    })
    await response.body?.cancel()
    return { versionId: response.headers.get('x-amz-version-id') }
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.client.request({ method: 'GET', key, allow: [404] })
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    return Buffer.from(await response.arrayBuffer())
  }

  async head(key: string): Promise<ArchivedObject | null> {
    const response = await this.client.request({ method: 'HEAD', key, allow: [404] })
    if (response.status === 404) return null
    const h = response.headers
    return {
      sizeBytes: Number(h.get('content-length') ?? 0),
      retainUntil: h.get('x-amz-object-lock-retain-until-date'),
      mode: h.get('x-amz-object-lock-mode'),
      versionId: h.get('x-amz-version-id'),
      sha256: h.get('x-amz-meta-sha256'),
    }
  }
}

/**
 * Retention of an archived document original: the whole day of `lockedUntil` (end of the 10-year
 * period, § 147 AO) is included, so Object Lock ends at 00:00 UTC of the following day.
 */
export function retainUntilOf(lockedUntil: string): Date {
  const date = new Date(`${lockedUntil.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date
}

/** Settings as in the environment (packages/config); without endpoint there is no archive. */
export interface ArchiveSettings {
  ARCHIVE_S3_ENDPOINT?: string | undefined
  ARCHIVE_S3_REGION: string
  ARCHIVE_S3_BUCKET: string
  ARCHIVE_S3_ACCESS_KEY?: string | undefined
  ARCHIVE_S3_SECRET_KEY?: string | undefined
  ARCHIVE_S3_PATH_STYLE: boolean
  ARCHIVE_RETENTION_MODE: RetentionMode
}

export function archiveStoreFromSettings(settings: ArchiveSettings): ArchiveStore | null {
  if (!settings.ARCHIVE_S3_ENDPOINT) return null
  return new S3ArchiveStore(
    {
      endpoint: settings.ARCHIVE_S3_ENDPOINT,
      region: settings.ARCHIVE_S3_REGION,
      bucket: settings.ARCHIVE_S3_BUCKET,
      accessKeyId: settings.ARCHIVE_S3_ACCESS_KEY ?? '',
      secretAccessKey: settings.ARCHIVE_S3_SECRET_KEY ?? '',
      forcePathStyle: settings.ARCHIVE_S3_PATH_STYLE,
    },
    settings.ARCHIVE_RETENTION_MODE,
  )
}

/** Previous archive while moving to another S3 (read-only fallback of the reconciliation). */
export interface PreviousArchiveSettings {
  ARCHIVE_PREVIOUS_S3_ENDPOINT?: string | undefined
  ARCHIVE_PREVIOUS_S3_REGION: string
  ARCHIVE_PREVIOUS_S3_BUCKET: string
  ARCHIVE_PREVIOUS_S3_ACCESS_KEY?: string | undefined
  ARCHIVE_PREVIOUS_S3_SECRET_KEY?: string | undefined
  ARCHIVE_PREVIOUS_S3_PATH_STYLE: boolean
}

export function previousArchiveFromSettings(
  settings: PreviousArchiveSettings,
): Pick<ArchiveStore, 'get' | 'bucket'> | null {
  if (!settings.ARCHIVE_PREVIOUS_S3_ENDPOINT) return null
  return new S3ArchiveStore({
    endpoint: settings.ARCHIVE_PREVIOUS_S3_ENDPOINT,
    region: settings.ARCHIVE_PREVIOUS_S3_REGION,
    bucket: settings.ARCHIVE_PREVIOUS_S3_BUCKET,
    accessKeyId: settings.ARCHIVE_PREVIOUS_S3_ACCESS_KEY ?? '',
    secretAccessKey: settings.ARCHIVE_PREVIOUS_S3_SECRET_KEY ?? '',
    forcePathStyle: settings.ARCHIVE_PREVIOUS_S3_PATH_STYLE,
  })
}
