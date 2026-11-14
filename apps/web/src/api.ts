import type { Problem } from '@opc/schemas'
import { t } from './i18n'
import {
  cachedGet,
  hasWaitingChanges,
  localFirst,
  markServerReachable,
  type QueuedChange,
  queueChange,
  storeGet,
  syncNow,
} from './offline/client'

/** Error from the API with the German `detail` and optional field errors (RFC 9457). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message)
  }
}

/**
 * Small fetch wrapper. The session lives in an HttpOnly cookie (never in localStorage, rule 9);
 * POST requests carry an Idempotency-Key so double clicks do not create duplicates (rule 10).
 */
export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return (await apiWithEtag<T>(method, path, body)).data
}

/**
 * Like api(), additionally returns the ETag of single resources and sends If-Match,
 * so concurrent edits are detected (412) instead of silently overwritten.
 */
export async function apiWithEtag<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  ifMatch?: string | null,
): Promise<{ data: T; etag: string | null }> {
  if (method === 'GET') {
    // Local changes still waiting for the server: show them, not the older server state.
    const local = await localFirst<T>(path)
    if (local) return local
    try {
      const result = await send<T>(path, { method, headers: { accept: 'application/json' } })
      markServerReachable()
      await storeGet(path, result.data, result.etag)
      return result
    } catch (error) {
      // No network: the site screens work with what the device has stored (ADR 0010).
      if (error instanceof ApiError && error.status === 0) {
        const cached = await cachedGet<T>(path)
        if (cached) return cached
      }
      throw error
    }
  }
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method === 'POST') headers['idempotency-key'] = crypto.randomUUID()
  if (ifMatch) headers['if-match'] = ifMatch
  return send<T>(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * A change of the site modules (Aufmaß, Bautagebuch, Fotos) that also works without network:
 * online it is sent right away; offline – or while earlier changes still wait – it goes into the
 * outbox, the screen shows it at once (marked as not yet transferred) and it is sent later.
 */
export async function mutate<T>(
  change: QueuedChange<T>,
): Promise<{ data: T; etag: string | null; queued: boolean }> {
  if (navigator.onLine && !(await hasWaitingChanges())) {
    try {
      const result = change.blob
        ? await send<T>(change.path, {
            method: change.method,
            headers: {
              accept: 'application/json',
              'content-type': 'application/octet-stream',
              'idempotency-key': crypto.randomUUID(),
            },
            body: change.blob,
          })
        : await apiWithEtag<T>(change.method, change.path, change.json)
      markServerReachable()
      await storeGet(change.resource, result.data, result.etag)
      return { ...result, queued: false }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 0)) throw error
    }
  }
  const data = await queueChange(change)
  void syncNow()
  return { data, etag: null, queued: true }
}

/** Uploads a file as raw bytes (streamed on the server, no form encoding). */
export async function uploadFile<T>(path: string, file: Blob): Promise<T> {
  return (
    await send<T>(path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        'idempotency-key': crypto.randomUUID(),
      },
      body: file,
    })
  ).data
}

async function send<T>(path: string, init: RequestInit): Promise<{ data: T; etag: string | null }> {
  let response: Response
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, t('common.networkError'))
  }
  const etag = response.headers.get('etag')
  if (response.status === 204) return { data: undefined as T, etag }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const problem = data as Problem | null
    throw new ApiError(
      response.status,
      problem?.detail ?? response.statusText,
      problem?.errors ?? {},
    )
  }
  return { data: data as T, etag }
}

/**
 * Downloads a generated file (export). Errors arrive as Problem Details and are shown
 * instead of being saved as a file.
 */
export async function downloadFile(path: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, t('common.networkError'))
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as Problem | null
    throw new ApiError(
      response.status,
      problem?.detail ?? response.statusText,
      problem?.errors ?? {},
    )
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'export'
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
