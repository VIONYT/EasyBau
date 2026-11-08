import type { Problem } from '@opc/schemas'
import { t } from './i18n'

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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method === 'POST') headers['idempotency-key'] = crypto.randomUUID()
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new ApiError(0, t('common.networkError'))
  }
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const problem = data as Problem | null
    throw new ApiError(
      response.status,
      problem?.detail ?? response.statusText,
      problem?.errors ?? {},
    )
  }
  return data as T
}
