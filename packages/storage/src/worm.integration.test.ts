import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { S3ArchiveStore } from './archive.js'
import type { S3Client } from './s3.js'

/**
 * WORM attack suite for the Belegarchiv (ADR 0008), independent of the S3 product: everything the
 * app's own credentials could try against a locked original must fail. Runs against any S3 with
 * ARCHIVE_S3_ENDPOINT (+ ARCHIVE_S3_ACCESS_KEY/SECRET_KEY). With WORM_STATE=<file> the first run
 * stores bucket/key/version there; a second run with WORM_RESUME=1 checks the lock after a restart.
 */
const endpoint = process.env.ARCHIVE_S3_ENDPOINT
const statePath = process.env.WORM_STATE
const resume = process.env.WORM_RESUME === '1'

interface State {
  bucket: string
  key: string
  versionId: string
  retainUntil: string
  sha256: string
}

const md5 = (body: Buffer) => createHash('md5').update(body).digest('base64')
const retentionXml = (mode: string, until: Date) =>
  Buffer.from(
    `<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>${mode}</Mode><RetainUntilDate>${until.toISOString()}</RetainUntilDate></Retention>`,
  )

function storeFor(bucket: string) {
  const store = new S3ArchiveStore({
    endpoint: endpoint as string,
    region: process.env.ARCHIVE_S3_REGION ?? 'us-east-1',
    bucket,
    accessKeyId: process.env.ARCHIVE_S3_ACCESS_KEY as string,
    secretAccessKey: process.env.ARCHIVE_S3_SECRET_KEY as string,
    forcePathStyle: true,
  })
  const client = (store as unknown as { client: S3Client }).client
  return { store, client }
}

/** Status of a request that must be refused (any 4xx); 2xx means the attack worked. */
async function refused(call: Promise<Response>): Promise<number> {
  try {
    const response = await call
    await response.body?.cancel()
    return response.status
  } catch (error) {
    return (error as { status?: number }).status ?? 0
  }
}

describe.skipIf(!endpoint || resume)('WORM attack suite (real S3)', () => {
  const bucket = `worm-${randomUUID().slice(0, 8)}`
  const { store, client } = storeFor(bucket)
  const key = 'tenant/documents/doc/original'
  const data = Buffer.from('%PDF-1.7 Rechnung R-00101 – Original')
  const sha256 = createHash('sha256').update(data).digest()
  const retainUntil = new Date(Date.now() + 3 * 24 * 3600 * 1000)
  let versionId = ''

  beforeAll(async () => {
    await store.ensureBucket()
    versionId =
      (await store.put(key, data, { sha256, contentType: 'application/pdf', retainUntil }))
        .versionId ?? ''
    if (statePath) {
      const state: State = {
        bucket,
        key,
        versionId,
        retainUntil: retainUntil.toISOString(),
        sha256: sha256.toString('hex'),
      }
      writeFileSync(statePath, JSON.stringify(state))
    }
  })

  it('creates a bucket with Object Lock and versioning', async () => {
    expect(await store.status()).toMatchObject({ bucketExists: true, objectLock: true })
    await store.ensureBucket() // idempotent
    const versioning = await (
      await client.request({ method: 'GET', query: { versioning: '' } })
    ).text()
    expect(versioning).toContain('<Status>Enabled</Status>')
  })

  it('stores retention, checksum metadata and a version id', async () => {
    expect(versionId).not.toBe('')
    expect(await store.head(key)).toMatchObject({
      sizeBytes: data.length,
      mode: 'COMPLIANCE',
      sha256: sha256.toString('hex'),
      versionId,
    })
    const head = await store.head(key)
    expect(Math.abs(Date.parse(head?.retainUntil ?? '') - retainUntil.getTime())).toBeLessThan(1000)
    expect((await store.get(key))?.equals(data)).toBe(true)
    const retention = await (
      await client.request({ method: 'GET', key, query: { retention: '', versionId } })
    ).text()
    expect(retention).toContain('COMPLIANCE')
  })

  it('rejects an upload whose content does not match its SHA-256 checksum', async () => {
    const status = await refused(
      client.request({
        method: 'PUT',
        key: 'tenant/documents/doc/corrupt',
        body: Buffer.from('anderer Inhalt'),
        headers: { 'x-amz-checksum-sha256': sha256.toString('base64') },
      }),
    )
    expect(status).toBeGreaterThanOrEqual(400)
  })

  it('refuses deleting the locked version', async () => {
    expect(
      await refused(client.request({ method: 'DELETE', key, query: { versionId } })),
    ).toBeGreaterThanOrEqual(400)
  })

  it('refuses deleting with the governance bypass header', async () => {
    const status = await refused(
      client.request({
        method: 'DELETE',
        key,
        query: { versionId },
        headers: { 'x-amz-bypass-governance-retention': 'true' },
      }),
    )
    expect(status).toBeGreaterThanOrEqual(400)
  })

  it('refuses shortening the retention', async () => {
    const body = retentionXml('COMPLIANCE', new Date(Date.now() + 3600 * 1000))
    const status = await refused(
      client.request({
        method: 'PUT',
        key,
        query: { retention: '', versionId },
        body,
        headers: { 'content-md5': md5(body), 'content-type': 'application/xml' },
      }),
    )
    expect(status).toBeGreaterThanOrEqual(400)
  })

  it('refuses switching COMPLIANCE to GOVERNANCE', async () => {
    const body = retentionXml('GOVERNANCE', retainUntil)
    const status = await refused(
      client.request({
        method: 'PUT',
        key,
        query: { retention: '', versionId },
        body,
        headers: {
          'content-md5': md5(body),
          'content-type': 'application/xml',
          'x-amz-bypass-governance-retention': 'true',
        },
      }),
    )
    expect(status).toBeGreaterThanOrEqual(400)
  })

  it('refuses suspending versioning on the locked bucket', async () => {
    const body = Buffer.from(
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>',
    )
    const status = await refused(
      client.request({
        method: 'PUT',
        query: { versioning: '' },
        body,
        headers: { 'content-md5': md5(body), 'content-type': 'application/xml' },
      }),
    )
    expect(status).toBeGreaterThanOrEqual(400)
  })

  it('refuses deleting the bucket', async () => {
    expect(await refused(client.request({ method: 'DELETE' }))).toBeGreaterThanOrEqual(400)
  })

  it('refuses force-deleting the bucket (product-specific force headers)', async () => {
    const status = await refused(
      client.request({
        method: 'DELETE',
        headers: {
          'x-minio-force-delete': 'true',
          'x-rustfs-force-delete': 'true',
          'x-amz-bypass-governance-retention': 'true',
        },
      }),
    )
    expect(status).toBeGreaterThanOrEqual(400)
    const original = await client.request({ method: 'GET', key, query: { versionId } })
    expect(Buffer.from(await original.arrayBuffer()).equals(data)).toBe(true)
  })

  it('does not let a PUT with ?versionId= overwrite the locked version', async () => {
    const response = await client
      .request({
        method: 'PUT',
        key,
        query: { versionId },
        body: Buffer.from('überschreiben'),
        allow: [400, 403, 404, 405, 409, 501],
      })
      .catch(() => null)
    await response?.body?.cancel()
    const original = await client.request({ method: 'GET', key, query: { versionId } })
    expect(Buffer.from(await original.arrayBuffer()).equals(data)).toBe(true)
  })

  it('keeps the locked version when the key is overwritten or deleted without version', async () => {
    const other = Buffer.from('überschrieben')
    await store.put(key, other, {
      sha256: createHash('sha256').update(other).digest(),
      contentType: 'text/plain',
      retainUntil,
    })
    expect((await store.get(key))?.equals(other)).toBe(true)
    // A plain DELETE only adds a delete marker.
    const marker = await client.request({ method: 'DELETE', key, allow: [204, 200] })
    await marker.body?.cancel()
    const original = await client.request({ method: 'GET', key, query: { versionId } })
    expect(Buffer.from(await original.arrayBuffer()).equals(data)).toBe(true)
  })
})

describe.skipIf(!endpoint || !resume || !statePath)('WORM after restart (real S3)', () => {
  it('still has the original and still refuses deleting it', async () => {
    const state = JSON.parse(readFileSync(statePath as string, 'utf8')) as State
    const { client } = storeFor(state.bucket)
    const original = await client.request({
      method: 'GET',
      key: state.key,
      query: { versionId: state.versionId },
    })
    const body = Buffer.from(await original.arrayBuffer())
    expect(createHash('sha256').update(body).digest('hex')).toBe(state.sha256)
    const retention = await (
      await client.request({
        method: 'GET',
        key: state.key,
        query: { retention: '', versionId: state.versionId },
      })
    ).text()
    expect(retention).toContain('COMPLIANCE')
    expect(
      await refused(
        client.request({ method: 'DELETE', key: state.key, query: { versionId: state.versionId } }),
      ),
    ).toBeGreaterThanOrEqual(400)
  })
})
