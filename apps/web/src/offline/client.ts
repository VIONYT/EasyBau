import type { Me } from '@opc/schemas'
import { useEffect, useState } from 'react'
import { OfflineDb, type OutboxEntry } from './db'
import {
  discardEntry,
  flushOutbox,
  isCacheable,
  pendingFor,
  readCache,
  retryEntry,
  waiting,
  writeCache,
} from './outbox'

/**
 * Offline layer of the web app (ADR 0010): GET answers of the site modules are cached, changes
 * made without network go into the outbox and are synced in order as soon as the device is online.
 */

let database: OfflineDb | null = null
const db = () => {
  database ??= new OfflineDb()
  return database
}

let owner: string | null = null
const ownerOf = (me: Pick<Me, 'user' | 'tenant'>) => `${me.user.id}:${me.tenant.id}`

export interface OfflineStatus {
  online: boolean
  /** A screen shows data from the device because the server was not reachable. */
  usingCache: boolean
  syncing: boolean
  needsLogin: boolean
  entries: OutboxEntry[]
}

let status: OfflineStatus = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  usingCache: false,
  syncing: false,
  needsLogin: false,
  entries: [],
}
const listeners = new Set<(s: OfflineStatus) => void>()
const publish = (patch: Partial<OfflineStatus>) => {
  status = { ...status, ...patch }
  for (const listener of listeners) listener(status)
}

async function refreshEntries() {
  publish({ entries: owner ? await waiting(db(), owner) : [] })
}

export function useOfflineStatus(): OfflineStatus {
  const [state, setState] = useState(status)
  useEffect(() => {
    listeners.add(setState)
    setState(status)
    return () => {
      listeners.delete(setState)
    }
  }, [])
  return state
}

/** The signed-in account: cache and outbox of another account are not used. */
export async function setOfflineOwner(me: Pick<Me, 'user' | 'tenant'> | null) {
  const next = me ? ownerOf(me) : null
  const [stored] = await db().meta.where('key').equals('owner').toArray()
  if (next && stored && stored.value !== next) await db().cache.clear()
  if (next) await db().meta.put({ key: 'owner', value: next })
  owner = next
  publish({ needsLogin: false })
  await refreshEntries()
  if (next) void syncNow()
}

/** Signing out removes the cached data from the device (waiting changes stay for that account). */
export async function clearOfflineData() {
  await db().cache.clear()
  await db().meta.delete('owner')
  owner = null
  await refreshEntries()
}

export const markServerReachable = () => {
  if (status.usingCache || !status.online) publish({ usingCache: false, online: true })
}

/** GET with offline fallback; returns null when nothing is cached. */
export async function cachedGet<T>(path: string): Promise<{ data: T; etag: string | null } | null> {
  if (!isCacheable(path)) return null
  const entry = await readCache<T>(db(), path)
  if (!entry) return null
  publish({ usingCache: true })
  return { data: entry.data as T, etag: entry.etag }
}

/** Waiting local changes to this resource: the local copy is newer than the server's. */
export async function localFirst<T>(
  path: string,
): Promise<{ data: T; etag: string | null } | null> {
  if (!owner || !(await pendingFor(db(), owner, path))) return null
  const entry = await readCache<T>(db(), path)
  return entry ? { data: entry.data as T, etag: null } : null
}

export async function storeGet(path: string, data: unknown, etag: string | null) {
  if (isCacheable(path)) await writeCache(db(), path, data, etag)
}

export async function hasWaitingChanges(): Promise<boolean> {
  if (!owner) return false
  return (await waiting(db(), owner)).some((e) => e.status === 'pending')
}

export interface QueuedChange<T> {
  method: OutboxEntry['method']
  path: string
  json?: unknown
  blob?: Blob
  /** Cached resource that shows the change (and receives the server answer). */
  resource: string
  label: string
  /** Applies the change to the cached resource (undefined when it does not exist yet). */
  optimistic: (current: T | undefined) => T
  /** Further cached views to adjust, e.g. the list of reports. */
  alsoUpdate?: { resource: string; apply: (current: unknown) => unknown }[]
}

/** Puts a change into the outbox and shows it locally right away. */
export async function queueChange<T>(change: QueuedChange<T>): Promise<T> {
  if (!owner) throw new Error('not signed in')
  const current = await readCache<T>(db(), change.resource)
  const next = change.optimistic(current?.data as T | undefined)
  await writeCache(db(), change.resource, next, current?.etag ?? null)
  for (const other of change.alsoUpdate ?? []) {
    const cached = await readCache(db(), other.resource)
    if (cached) await writeCache(db(), other.resource, other.apply(cached.data), cached.etag)
  }
  await db().outbox.add({
    owner,
    method: change.method,
    path: change.path,
    ...(change.json === undefined ? {} : { json: change.json }),
    ...(change.blob ? { blob: change.blob } : {}),
    idempotencyKey: crypto.randomUUID(),
    resource: change.resource,
    label: change.label,
    createdAt: Date.now(),
    status: 'pending',
    attempts: 0,
  })
  await refreshEntries()
  return next
}

async function sendEntry(entry: OutboxEntry): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (entry.method === 'POST') headers['idempotency-key'] = entry.idempotencyKey
  let body: BodyInit | undefined
  if (entry.blob) {
    headers['content-type'] = 'application/octet-stream'
    body = entry.blob
  } else if (entry.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(entry.json)
  }
  return fetch(entry.path, {
    method: entry.method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body }),
  })
}

let running: Promise<void> | null = null

/** Sends waiting changes now (also called on „online“, every 30 s and when the app is shown). */
export function syncNow(): Promise<void> {
  if (!owner) return Promise.resolve()
  running ??= (async () => {
    publish({ syncing: true })
    try {
      const result = await flushOutbox(db(), owner as string, sendEntry)
      publish({
        needsLogin: result.needsLogin,
        online: !result.interrupted || status.online,
        ...(result.sent && !result.interrupted ? { usingCache: false } : {}),
      })
    } finally {
      publish({ syncing: false })
      await refreshEntries()
      running = null
    }
  })()
  return running
}

export async function retryChange(seq: number) {
  await retryEntry(db(), seq)
  await refreshEntries()
  void syncNow()
}

export async function discardChange(seq: number) {
  await discardEntry(db(), seq)
  await refreshEntries()
}

/** Local picture of a photo that still waits in the outbox. */
export async function waitingBlob(seq: number): Promise<Blob | null> {
  return (await db().outbox.get(seq))?.blob ?? null
}

let started = false
export function startOfflineSync() {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('online', () => {
    publish({ online: true })
    void syncNow()
  })
  window.addEventListener('offline', () => publish({ online: false }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
  setInterval(() => void syncNow(), 30_000)
}
