import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { S3ArchiveStore } from './archive.js'
import type { S3Client } from './s3.js'

/**
 * Restricted access key of the app for the bundled archive (ADR 0009, infra/storage/setup.sh):
 * it may archive and read originals, but neither delete anything (not even a delete marker) nor
 * change the bucket. Runs with ARCHIVE_APP_ENDPOINT, ARCHIVE_APP_ACCESS_KEY, ARCHIVE_APP_SECRET_KEY
 * and ARCHIVE_APP_BUCKET (the bucket created by the setup).
 */
const endpoint = process.env.ARCHIVE_APP_ENDPOINT

const md5 = (body: Buffer) => createHash('md5').update(body).digest('base64')

async function status(call: Promise<Response>): Promise<number> {
  try {
    const response = await call
    await response.body?.cancel()
    return response.status
  } catch (error) {
    return (error as { status?: number }).status ?? 0
  }
}

describe.skipIf(!endpoint)('Restricted app key of the archive (real S3)', () => {
  const store = new S3ArchiveStore({
    endpoint: endpoint as string,
    region: 'us-east-1',
    bucket: process.env.ARCHIVE_APP_BUCKET ?? 'belegarchiv',
    accessKeyId: process.env.ARCHIVE_APP_ACCESS_KEY as string,
    secretAccessKey: process.env.ARCHIVE_APP_SECRET_KEY as string,
    forcePathStyle: true,
  })
  const client = (store as unknown as { client: S3Client }).client
  const key = `tenant/documents/${randomUUID()}/original`
  const data = Buffer.from('%PDF-1.7 Original für den App-Schlüssel')
  const sha256 = createHash('sha256').update(data).digest()

  it('sees the bucket with Object Lock and archives, reads and checks originals', async () => {
    expect(await store.status()).toMatchObject({ reachable: true, objectLock: true })
    const { versionId } = await store.put(key, data, {
      sha256,
      contentType: 'application/pdf',
      retainUntil: new Date(Date.now() + 2 * 24 * 3600 * 1000),
    })
    expect(versionId).toBeTruthy()
    expect((await store.get(key))?.equals(data)).toBe(true)
    // Retention and checksum are visible to the reconciliation (HEAD).
    expect(await store.head(key)).toMatchObject({
      mode: 'COMPLIANCE',
      sha256: sha256.toString('hex'),
      retainUntil: expect.any(String),
    })
  })

  it('may not delete anything, not even a delete marker', async () => {
    expect(await status(client.request({ method: 'DELETE', key }))).toBe(403)
    expect((await store.get(key))?.equals(data)).toBe(true)
  })

  it('may not change or delete the bucket or create others', async () => {
    const body = Buffer.from(
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>',
    )
    expect(
      await status(
        client.request({
          method: 'PUT',
          query: { versioning: '' },
          body,
          headers: { 'content-md5': md5(body) },
        }),
      ),
    ).toBe(403)
    expect(await status(client.request({ method: 'DELETE' }))).toBe(403)
    const other = new S3ArchiveStore({
      endpoint: endpoint as string,
      region: 'us-east-1',
      bucket: `fremd-${randomUUID().slice(0, 8)}`,
      accessKeyId: process.env.ARCHIVE_APP_ACCESS_KEY as string,
      secretAccessKey: process.env.ARCHIVE_APP_SECRET_KEY as string,
      forcePathStyle: true,
    })
    await expect(other.ensureBucket()).rejects.toThrow()
  })

  it('may not set a weaker retention or bypass it', async () => {
    const body = Buffer.from(
      `<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>GOVERNANCE</Mode><RetainUntilDate>${new Date(Date.now() + 3600_000).toISOString()}</RetainUntilDate></Retention>`,
    )
    const code = await status(
      client.request({
        method: 'PUT',
        key,
        query: { retention: '' },
        body,
        headers: { 'content-md5': md5(body), 'x-amz-bypass-governance-retention': 'true' },
      }),
    )
    expect(code).toBeGreaterThanOrEqual(400)
    expect((await store.head(key))?.mode).toBe('COMPLIANCE')
  })
})
