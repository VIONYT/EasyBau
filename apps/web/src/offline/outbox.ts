import type { CacheEntry, OfflineDb, OutboxEntry } from './db'

/**
 * Sync engine of the offline outbox: sends waiting changes in the order they were made, each with
 * its own Idempotency-Key (a repeated send after a lost answer is not applied twice). Pure logic
 * over the IndexedDB tables and an injected `send`, so it is testable without a browser.
 */

export type Sender = (entry: OutboxEntry) => Promise<Response>

export interface FlushResult {
  sent: number
  failed: number
  /** Stopped because the network is gone (or the server is unavailable): try again later. */
  interrupted: boolean
  /** The session expired: sign in again, nothing is lost. */
  needsLogin: boolean
}

/** Paths whose GET answers are kept for offline use (site modules only, no finance data). */
const CACHEABLE = [
  /^\/api\/v1\/auth\/me$/,
  /^\/api\/v1\/units$/,
  /^\/api\/v1\/report-templates$/,
  /^\/api\/v1\/projects(\?.*)?$/,
  /^\/api\/v1\/projects\/[0-9a-f-]{36}$/,
  /^\/api\/v1\/projects\/[0-9a-f-]{36}\/(measurement-sheets|measurable-items|reports|folders)(\?.*)?$/,
  /^\/api\/v1\/measurement-sheets\/[0-9a-f-]{36}$/,
  /^\/api\/v1\/reports\/[0-9a-f-]{36}$/,
]

export const isCacheable = (path: string) => CACHEABLE.some((pattern) => pattern.test(path))

export async function readCache<T>(db: OfflineDb, url: string): Promise<CacheEntry | undefined> {
  return (await db.cache.get(url)) as (CacheEntry & { data: T }) | undefined
}

export async function writeCache(db: OfflineDb, url: string, data: unknown, etag: string | null) {
  await db.cache.put({ url, data, etag, storedAt: Date.now() })
}

export async function pendingFor(db: OfflineDb, owner: string, resource: string): Promise<boolean> {
  return (
    (await db.outbox
      .where('resource')
      .equals(resource)
      .filter((e) => e.owner === owner && e.status === 'pending')
      .count()) > 0
  )
}

export async function waiting(db: OfflineDb, owner: string): Promise<OutboxEntry[]> {
  return (await db.outbox.orderBy('seq').toArray()).filter((e) => e.owner === owner)
}

async function problemText(response: Response): Promise<string> {
  const problem = (await response.json().catch(() => null)) as {
    detail?: string
    errors?: Record<string, string>
  } | null
  const details = Object.values(problem?.errors ?? {})
  return [problem?.detail ?? `Fehler ${response.status}`, ...details].join(' ')
}

/** Sends the waiting changes of `owner` in order; stops at the first network failure. */
export async function flushOutbox(
  db: OfflineDb,
  owner: string,
  send: Sender,
): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, failed: 0, interrupted: false, needsLogin: false }
  const entries = (await waiting(db, owner)).filter((e) => e.status === 'pending')
  for (const entry of entries) {
    const seq = entry.seq as number
    let response: Response
    try {
      response = await send(entry)
    } catch {
      result.interrupted = true
      break
    }
    if (response.status === 401) {
      result.needsLogin = true
      break
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      // Server busy or unavailable (e.g. during an update): keep the order, try again later.
      await db.outbox.update(seq, { attempts: entry.attempts + 1 })
      result.interrupted = true
      break
    }
    if (!response.ok) {
      // Refused for good (e.g. the Aufmaßblatt was signed meanwhile): keep it for the person and
      // drop the optimistic copy, so the screen shows the server state again.
      await db.outbox.update(seq, {
        status: 'failed',
        attempts: entry.attempts + 1,
        error: await problemText(response),
      })
      await db.cache.delete(entry.resource)
      result.failed += 1
      continue
    }
    await db.outbox.delete(seq)
    // The server answer replaces the optimistic copy – unless later changes to the same resource
    // still wait (their optimistic state already contains this one).
    if (!(await pendingFor(db, owner, entry.resource))) {
      const data = response.status === 204 ? null : await response.json().catch(() => null)
      if (data !== null) await writeCache(db, entry.resource, data, response.headers.get('etag'))
    }
    result.sent += 1
  }
  return result
}

/** Sends a failed change again (e.g. after correcting the cause on the server). */
export async function retryEntry(db: OfflineDb, seq: number) {
  await db.outbox.update(seq, (entry) => {
    entry.status = 'pending'
    delete entry.error
  })
}

/** Gives up a change that the server refused. */
export async function discardEntry(db: OfflineDb, seq: number) {
  await db.outbox.delete(seq)
}
