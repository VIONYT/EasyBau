/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { OfflineDb } from './offline/db'
import {
  BACKGROUND_SYNC_TAG,
  exclusive,
  type FlushResult,
  flushOutbox,
  sendEntry,
  storedOwner,
} from './offline/outbox'

/**
 * Service worker (ADR 0010): the app shell for offline use and – where the browser supports
 * Background Sync – sending the outbox while the app is closed. API answers are never cached
 * here; the app keeps its site data itself (src/offline).
 */

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[]
}

/** Background Sync (not in the TypeScript DOM/WebWorker types). */
interface SyncEvent extends ExtendableEvent {
  readonly tag: string
  readonly lastChance: boolean
}

// registerType „autoUpdate“: a new version takes over at once.
self.skipWaiting()
clientsClaim()

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/healthz/, /^\/readyz/],
  }),
)

/**
 * Sends the outbox of the signed-in account (the one the app stored; none after logout). An
 * interruption (still offline, server busy) rejects, so the browser tries again later.
 */
async function backgroundFlush(): Promise<void> {
  const db = new OfflineDb()
  let result: FlushResult | null = null
  try {
    result = await exclusive(async () => {
      const owner = await storedOwner(db)
      return owner ? flushOutbox(db, owner, sendEntry) : null
    })
  } finally {
    db.close()
  }
  if (result?.sent || result?.failed) {
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.postMessage({ type: 'outbox-synced' })
    }
  }
  if (result?.interrupted) throw new Error('outbox: still offline, retry later')
}

self.addEventListener('sync', (event) => {
  const sync = event as SyncEvent
  if (sync.tag === BACKGROUND_SYNC_TAG) sync.waitUntil(backgroundFlush())
})
