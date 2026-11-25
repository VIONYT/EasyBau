import Dexie, { type Table } from 'dexie'

/**
 * Local storage for the site modules (DESIGN.md §6 Offline-Sync, ADR 0010), in IndexedDB:
 * - cache: last server answer of the GET requests a site screen needs (projects, Aufmaß,
 *   Bautagebuch …), so the screens open without network. Finance data is never cached.
 * - outbox: changes made without network, sent in order with their Idempotency-Key once the
 *   device is online again.
 * Nothing here is a session secret: the session stays in the HttpOnly cookie (rule 9).
 */

export interface CacheEntry {
  url: string
  data: unknown
  etag: string | null
  storedAt: number
}

export type OutboxStatus = 'pending' | 'failed'

export interface OutboxEntry {
  seq?: number
  /** Account the change belongs to (user:tenant); only sent while that account is signed in. */
  owner: string
  method: 'POST' | 'PATCH' | 'DELETE'
  path: string
  json?: unknown
  /** Photos: the picture itself (sent as application/octet-stream). */
  blob?: Blob
  idempotencyKey: string
  /** Cached resource the answer replaces, e.g. /api/v1/measurement-sheets/<id>. */
  resource: string
  /** For the person: what is waiting, e.g. „Aufmaßzeile 4,25*2,6“. */
  label: string
  createdAt: number
  status: OutboxStatus
  attempts: number
  error?: string
}

export interface MetaEntry {
  key: string
  value: string
}

export class OfflineDb extends Dexie {
  cache!: Table<CacheEntry, string>
  outbox!: Table<OutboxEntry, number>
  meta!: Table<MetaEntry, string>

  constructor(name = 'easybau-offline') {
    super(name)
    this.version(1).stores({
      cache: 'url',
      outbox: '++seq, owner, status, resource',
      meta: 'key',
    })
  }
}
