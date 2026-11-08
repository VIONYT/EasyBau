import type { Problem } from '@opc/schemas'
import type { FastifyReply } from 'fastify'
import type { z } from 'zod'

/** Error carrying an HTTP status and a German, user-facing message (RFC 9457 `detail`). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly errors?: Record<string, string>,
    readonly title?: string,
  ) {
    super(message)
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
}

export function problem(status: number, detail: string, errors?: Record<string, string>): Problem {
  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    ...(errors ? { errors } : {}),
  }
}

export function sendProblem(
  reply: FastifyReply,
  status: number,
  detail: string,
  errors?: Record<string, string>,
) {
  return reply
    .status(status)
    .type('application/problem+json')
    .send(problem(status, detail, errors))
}

/** Validates input with a zod schema; throws a 400 HttpError with field messages. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {})
  if (result.success) return result.data
  const errors: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '_'
    errors[path] ??=
      issue.code === 'invalid_type' && issue.input === undefined ? 'Pflichtfeld.' : issue.message
  }
  throw new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)
}

export const notFound = (what = 'Der Eintrag') =>
  new HttpError(404, `${what} wurde nicht gefunden.`)
export const forbidden = () => new HttpError(403, 'Dafür fehlt Ihnen die Berechtigung.')

/** Opaque keyset cursor. */
export function encodeCursor(values: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url')
}

export function decodeCursor(
  cursor: string | undefined,
  length: number,
): (string | number)[] | null {
  if (!cursor) return null
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(values) && values.length === length) return values
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Ungültiger Seiten-Cursor.')
}

/** Strong ETag from a row version (updated_at), for optimistic locking with If-Match. */
export function etagOf(updatedAt: Date | string): string {
  return `"${new Date(updatedAt).getTime().toString(36)}"`
}

export function checkIfMatch(header: string | undefined, updatedAt: Date | string): void {
  if (header && header !== etagOf(updatedAt)) {
    throw new HttpError(
      412,
      'Der Eintrag wurde inzwischen geändert. Bitte neu laden und erneut speichern.',
    )
  }
}
