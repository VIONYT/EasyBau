import { withTenant } from '@easybau/db'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Services } from './context.js'
import { HttpError } from './http.js'
import { sha256 } from './security/crypto.js'

/**
 * Idempotency-Key support for POST requests (CLAUDE.md rule 10).
 * The first request with a key is executed and its response stored; repeats with the same
 * key and the same body get the stored response (Idempotency-Replayed: true). The same key with
 * a different body is rejected. Failed requests (5xx) release the key so the client can retry,
 * and so does a request left without answer for 5 minutes (server restarted mid-request).
 * Keys are kept for 7 days (worker job `notification.purge`).
 */
export function idempotencyHooks(services: Services) {
  const preHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    request.idempotency = null
    const key = request.headers['idempotency-key']
    if (request.method !== 'POST' || typeof key !== 'string' || !request.auth) return
    if (key.length < 8 || key.length > 200) {
      throw new HttpError(400, 'Der Idempotency-Key muss 8 bis 200 Zeichen lang sein.')
    }
    const { tenantId, userId } = request.auth
    // Uploads are streamed (not buffered); their URL and length identify the request.
    const body = isStream(request.body)
      ? `stream:${request.headers['content-length'] ?? ''}`
      : JSON.stringify(request.body ?? null)
    // Bound to the person: a key reused by someone else never replays another user's response.
    const requestHash = sha256(`${userId}\n${request.method} ${request.url}\n${body}`)
    const result = await withTenant(services.sql, { tenantId, userId }, async (tx) => {
      const inserted = await tx`
        insert into idempotency_key (tenant_id, key, request_hash) values (${tenantId}, ${key}, ${requestHash})
        on conflict (tenant_id, key) do update set created_at = now()
          where idempotency_key.response_status is null
            and idempotency_key.request_hash = excluded.request_hash
            and idempotency_key.created_at < now() - interval '5 minutes'
        returning key`
      if (inserted.length) return { state: 'new' as const }
      const [row] = await tx<{ requestHash: Buffer; status: number | null; body: unknown }[]>`
        select request_hash as "requestHash", response_status as status, response_body as body
        from idempotency_key where tenant_id = ${tenantId} and key = ${key}`
      return { state: 'existing' as const, row }
    })
    if (result.state === 'new') {
      request.idempotency = { key, tenantId }
      return
    }
    const row = result.row
    if (!row?.requestHash.equals(requestHash)) {
      throw new HttpError(
        422,
        'Dieser Idempotency-Key wurde bereits für eine andere Anfrage verwendet.',
      )
    }
    if (row.status === null) throw new HttpError(409, 'Die Anfrage wird bereits verarbeitet.')
    reply.header('idempotency-replayed', 'true')
    return reply.status(row.status).send(row.body)
  }

  const onSend = async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const idem = request.idempotency
    if (!idem || !request.auth) return payload
    const { tenantId, userId } = request.auth
    await withTenant(services.sql, { tenantId, userId }, async (tx) => {
      if (reply.statusCode >= 500) {
        await tx`delete from idempotency_key where tenant_id = ${tenantId} and key = ${idem.key}`
        return
      }
      let body: unknown = null
      if (typeof payload === 'string' && payload.length) {
        try {
          body = JSON.parse(payload)
        } catch {
          body = null
        }
      }
      await tx`update idempotency_key set response_status = ${reply.statusCode}, response_body = ${tx.json(body as never)}
               where tenant_id = ${tenantId} and key = ${idem.key}`
    })
    return payload
  }

  return { preHandler, onSend }
}

function isStream(value: unknown): boolean {
  return typeof (value as { pipe?: unknown } | null)?.pipe === 'function'
}
