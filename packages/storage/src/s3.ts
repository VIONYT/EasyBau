import { createHash, createHmac } from 'node:crypto'

/**
 * Minimal S3 client (AWS Signature Version 4) for the Belegarchiv (ADR 0008): only the operations
 * the archive needs, for RustFS in the stack and any S3-compatible service with Object Lock
 * (AWS S3, Wasabi, Hetzner, IONOS, Backblaze B2 …). No SDK: fetch + node:crypto.
 */
export interface S3Config {
  /** e.g. http://storage:9000 or https://s3.eu-central-1.amazonaws.com */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Path style (http://host/bucket/key): RustFS, MinIO and most providers; false = bucket.host. */
  forcePathStyle: boolean
  timeoutMs?: number
}

export class S3Error extends Error {
  override name = 'S3Error'
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

/** RFC 3986 encoding as required by SigV4 (unreserved characters stay, everything else %XX). */
export function uriEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded
}

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest()

export interface SignInput {
  method: string
  url: URL
  /** Headers to sign (lower-case names); host is added from the URL. */
  headers: Record<string, string>
  payloadHash: string
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  date: Date
}

/** Returns the request headers including x-amz-date and Authorization (SigV4). */
export function signV4(input: SignInput): Record<string, string> {
  const service = input.service ?? 's3'
  const amzDate = input.date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: input.url.host,
    'x-amz-date': amzDate,
  }
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names
    .map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const signedHeaders = names.join(';')
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const path = input.url.pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/')
  const canonicalRequest = [
    input.method,
    path || '/',
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n')
  const scope = `${day}/${input.region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

function xmlValue(xml: string, tag: string): string | null {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null
}

export class S3Client {
  constructor(
    readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private urlOf(key: string | null, query: Record<string, string> = {}): URL {
    const base = new URL(this.config.endpoint)
    const objectPath = key
      ? `/${key
          .split('/')
          .map((s) => uriEncode(s))
          .join('/')}`
      : ''
    const url = this.config.forcePathStyle
      ? new URL(`${base.protocol}//${base.host}/${uriEncode(this.config.bucket)}${objectPath}`)
      : new URL(`${base.protocol}//${this.config.bucket}.${base.host}${objectPath || '/'}`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    return url
  }

  /** Signed request; non-2xx answers become S3Error with the S3 error code. */
  async request(options: {
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
    key?: string | null
    query?: Record<string, string>
    headers?: Record<string, string>
    body?: Buffer
    allow?: number[]
  }): Promise<Response> {
    const url = this.urlOf(options.key ?? null, options.query)
    const body = options.body
    const payloadHash = body ? createHash('sha256').update(body).digest('hex') : EMPTY_SHA256
    const headers = signV4({
      method: options.method,
      url,
      headers: { ...options.headers, 'x-amz-content-sha256': payloadHash },
      payloadHash,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      date: new Date(),
    })
    const { host: _, ...sendHeaders } = headers
    const response = await this.fetchImpl(url, {
      method: options.method,
      headers: sendHeaders,
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    })
    if (response.ok || options.allow?.includes(response.status)) return response
    const text = options.method === 'HEAD' ? '' : await response.text()
    throw new S3Error(
      response.status,
      xmlValue(text, 'Code') ?? `HTTP${response.status}`,
      xmlValue(text, 'Message') ?? `S3 answered HTTP ${response.status}`,
    )
  }
}
