import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ArchiveError, retainUntilOf, S3ArchiveStore } from './archive.js'
import { S3Error, signV4, uriEncode } from './s3.js'

describe('AWS Signature Version 4', () => {
  it('matches the AWS test suite (get-vanilla)', () => {
    const headers = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payloadHash: createHash('sha256').update('').digest('hex'),
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      date: new Date('2015-08-30T12:36:00Z'),
    })
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
    expect(headers['x-amz-date']).toBe('20150830T123600Z')
  })

  it('encodes keys per RFC 3986', () => {
    expect(uriEncode("a b+c!'()*ä")).toBe('a%20b%2Bc%21%27%28%29%2A%C3%A4')
    expect(uriEncode('t/documents/x', true)).toBe('t/documents/x')
  })
})

describe('Belegarchiv (S3 Object Lock)', () => {
  it('keeps the whole last day of the retention period', () => {
    expect(retainUntilOf('2037-12-31').toISOString()).toBe('2038-01-01T00:00:00.000Z')
  })

  const config = {
    endpoint: 'http://storage:9000',
    region: 'us-east-1',
    bucket: 'belegarchiv',
    accessKeyId: 'archive',
    secretAccessKey: 'secret-secret',
    forcePathStyle: true,
  }

  it('writes with retention, checksums and path-style URL', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const store = new S3ArchiveStore(config, 'COMPLIANCE', async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'v1' } })
    })
    const data = Buffer.from('%PDF-1.7 Beleg')
    const sha256 = createHash('sha256').update(data).digest()
    const result = await store.put('t1/documents/d1/a1', data, {
      sha256,
      contentType: 'application/pdf',
      retainUntil: new Date('2038-01-01T00:00:00Z'),
    })
    expect(result).toEqual({ versionId: 'v1' })
    expect(calls[0]?.url).toBe('http://storage:9000/belegarchiv/t1/documents/d1/a1')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers).toMatchObject({
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': '2038-01-01T00:00:00.000Z',
      'x-amz-checksum-sha256': sha256.toString('base64'),
      'x-amz-meta-sha256': sha256.toString('hex'),
      'content-md5': createHash('md5').update(data).digest('base64'),
    })
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=archive\//)
    await expect(
      store.put('k', data, {
        sha256: Buffer.alloc(32),
        contentType: 'application/pdf',
        retainUntil: new Date(),
      }),
    ).rejects.toThrow(ArchiveError)
  })

  it('reports bucket and Object Lock state and S3 errors', async () => {
    // HEAD bucket answers 200, then the lock configuration request answers `status`.
    const answer = (status: number, body: string) => async (_url: unknown, init?: RequestInit) =>
      init?.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(body, { status })
    const locked = new S3ArchiveStore(
      config,
      'COMPLIANCE',
      answer(
        200,
        '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
      ),
    )
    expect(await locked.status()).toEqual({
      reachable: true,
      bucketExists: true,
      objectLock: true,
      error: null,
    })
    const unlocked = new S3ArchiveStore(
      config,
      'COMPLIANCE',
      answer(404, '<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>'),
    )
    expect(await unlocked.status()).toMatchObject({ bucketExists: true, objectLock: false })
    const missing = new S3ArchiveStore(
      config,
      'COMPLIANCE',
      async () => new Response(null, { status: 404 }),
    )
    expect(await missing.status()).toMatchObject({ bucketExists: false, error: 'NoSuchBucket' })
    const denied = new S3ArchiveStore(
      config,
      'COMPLIANCE',
      answer(403, '<Error><Code>AccessDenied</Code><Message>no</Message></Error>'),
    )
    expect(await denied.status()).toMatchObject({ reachable: true, objectLock: false })
    await expect(denied.get('x')).rejects.toBeInstanceOf(S3Error)
    const down = new S3ArchiveStore(config, 'COMPLIANCE', async () => {
      throw new TypeError('fetch failed')
    })
    expect(await down.status()).toMatchObject({ reachable: false, error: 'fetch failed' })
  })
})

describe('listing archived keys', () => {
  it('follows continuation tokens of ListObjectsV2', async () => {
    const queries: string[] = []
    const pages = [
      '<ListBucketResult><Key>m/a&amp;b.json</Key><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken></ListBucketResult>',
      '<ListBucketResult><Key>m/c.json</Key><IsTruncated>false</IsTruncated></ListBucketResult>',
    ]
    const store = new S3ArchiveStore(
      {
        endpoint: 'http://s3.example.test',
        region: 'us-east-1',
        bucket: 'archive',
        accessKeyId: 'k',
        secretAccessKey: 's',
        forcePathStyle: true,
      },
      'COMPLIANCE',
      async (url) => {
        queries.push(new URL(String(url)).search)
        return new Response(pages[queries.length - 1], { status: 200 })
      },
    )
    expect(await store.list('m/')).toEqual(['m/a&b.json', 'm/c.json'])
    expect(queries[0]).toContain('list-type=2')
    expect(queries[1]).toContain('continuation-token=t%262')
  })
})

/** Against a real S3 with Object Lock (Docker test pipeline, CI): set ARCHIVE_S3_ENDPOINT and credentials. */
describe.skipIf(!process.env.ARCHIVE_S3_ENDPOINT)('Belegarchiv mit echtem S3 (integration)', () => {
  const store = new S3ArchiveStore({
    endpoint: process.env.ARCHIVE_S3_ENDPOINT as string,
    region: process.env.ARCHIVE_S3_REGION ?? 'us-east-1',
    bucket: `test-${randomUUID().slice(0, 8)}`,
    accessKeyId: process.env.ARCHIVE_S3_ACCESS_KEY as string,
    secretAccessKey: process.env.ARCHIVE_S3_SECRET_KEY as string,
    forcePathStyle: true,
  })

  it('creates a bucket with Object Lock, writes once and refuses changes before retention ends', async () => {
    expect((await store.status()).bucketExists).toBe(false)
    await store.ensureBucket()
    await store.ensureBucket() // idempotent
    expect(await store.status()).toMatchObject({ bucketExists: true, objectLock: true })

    const data = Buffer.from('<Invoice>Beleg ä</Invoice>')
    const sha256 = createHash('sha256').update(data).digest()
    const key = 'tenant/documents/doc/artifact'
    const { versionId } = await store.put(key, data, {
      sha256,
      contentType: 'application/xml',
      retainUntil: new Date(Date.now() + 2 * 24 * 3600 * 1000),
    })
    expect(versionId).toBeTruthy()
    expect((await store.get(key))?.equals(data)).toBe(true)
    expect(await store.head(key)).toMatchObject({
      sizeBytes: data.length,
      mode: 'COMPLIANCE',
      sha256: sha256.toString('hex'),
      versionId,
    })
    expect(await store.get('tenant/missing')).toBeNull()
    expect(await store.head('tenant/missing')).toBeNull()
    expect(await store.list('tenant/')).toEqual([key])
    expect(await store.list('other/')).toEqual([])

    // WORM: the locked version cannot be deleted, not even with the owner's credentials.
    const client = (store as unknown as { client: import('./s3.js').S3Client }).client
    await expect(
      client.request({ method: 'DELETE', key, query: { versionId: versionId as string } }),
    ).rejects.toMatchObject({ name: 'S3Error' })
    expect((await store.get(key))?.equals(data)).toBe(true)
  })
})
