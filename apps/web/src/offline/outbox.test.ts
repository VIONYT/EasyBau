import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
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

const OWNER = 'user-1:tenant-1'
const SHEET = '/api/v1/measurement-sheets/0195f3c4-0000-7000-8000-000000000001'
const REPORT = '/api/v1/reports/0195f3c4-0000-7000-8000-000000000002'

let db: OfflineDb
let n = 0

function entry(patch: Partial<OutboxEntry> = {}): OutboxEntry {
  n += 1
  return {
    owner: OWNER,
    method: 'POST',
    path: `${SHEET}/lines`,
    json: { formula: String(n) },
    idempotencyKey: `key-${n}`,
    resource: SHEET,
    label: `Zeile ${n}`,
    createdAt: n,
    status: 'pending',
    attempts: 0,
    ...patch,
  }
}

const json = (status: number, body: unknown, etag?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
  })

beforeEach(async () => {
  db = new OfflineDb(`test-${Math.random()}`)
  await db.open()
})

describe('Offline cache', () => {
  it('keeps only the site modules, never finance data', () => {
    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/units',
      '/api/v1/report-templates',
      '/api/v1/projects?limit=100',
      '/api/v1/projects/0195f3c4-0000-7000-8000-000000000003',
      '/api/v1/projects/0195f3c4-0000-7000-8000-000000000003/reports?template=daily_site_report',
      '/api/v1/projects/0195f3c4-0000-7000-8000-000000000003/measurable-items?kind=performance',
      SHEET,
      REPORT,
    ]) {
      expect(isCacheable(path), path).toBe(true)
    }
    for (const path of [
      '/api/v1/invoices',
      '/api/v1/documents/0195f3c4-0000-7000-8000-000000000003',
      '/api/v1/incoming-invoices',
      '/api/v1/contacts',
      '/api/v1/settings/company',
      `${SHEET}/pdf`,
    ]) {
      expect(isCacheable(path), path).toBe(false)
    }
  })
})

describe('Outbox', () => {
  it('sends in order and keeps the optimistic copy until the last change of a resource is through', async () => {
    await db.outbox.bulkAdd([
      entry(),
      entry({ method: 'PATCH', path: `${SHEET}/lines/x` }),
      entry({ resource: REPORT, path: REPORT, method: 'PATCH' }),
    ])
    await writeCache(db, SHEET, { optimistic: true }, null)
    const sent: string[] = []
    const result = await flushOutbox(db, OWNER, async (e) => {
      sent.push(`${e.method} ${e.idempotencyKey}`)
      return json(e.method === 'POST' ? 201 : 200, { answer: e.label }, `"v${sent.length}"`)
    })
    expect(result).toEqual({ sent: 3, failed: 0, interrupted: false, needsLogin: false })
    expect(sent.map((s) => s.split(' ')[0])).toEqual(['POST', 'PATCH', 'PATCH'])
    expect(await waiting(db, OWNER)).toEqual([])
    // The answer of the last change of each resource replaces the local copy.
    expect((await readCache(db, SHEET))?.data).toEqual({ answer: 'Zeile 2' })
    expect((await readCache(db, SHEET))?.etag).toBe('"v2"')
    expect((await readCache(db, REPORT))?.data).toEqual({ answer: 'Zeile 3' })
  })

  it('stops without network and keeps everything for the next attempt', async () => {
    await db.outbox.bulkAdd([entry(), entry()])
    let calls = 0
    const result = await flushOutbox(db, OWNER, async (e) => {
      calls += 1
      if (calls === 2) throw new TypeError('Failed to fetch')
      return json(201, { ok: e.label })
    })
    expect(result).toMatchObject({ sent: 1, interrupted: true })
    expect((await waiting(db, OWNER)).map((e) => e.status)).toEqual(['pending'])
    expect(await pendingFor(db, OWNER, SHEET)).toBe(true)
  })

  it('keeps a refused change with the reason, drops its local copy and goes on', async () => {
    await db.outbox.bulkAdd([entry(), entry({ resource: REPORT, path: REPORT, method: 'PATCH' })])
    await writeCache(db, SHEET, { optimistic: true }, null)
    const result = await flushOutbox(db, OWNER, async (e) =>
      e.resource === SHEET
        ? json(409, {
            detail: 'Das Aufmaßblatt ist unterschrieben.',
            errors: { formula: 'Bitte eine Korrekturzeile anlegen.' },
          })
        : json(200, { ok: true }),
    )
    expect(result).toMatchObject({ sent: 1, failed: 1, interrupted: false })
    const [failed] = await waiting(db, OWNER)
    expect(failed).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'Das Aufmaßblatt ist unterschrieben. Bitte eine Korrekturzeile anlegen.',
    })
    expect(await readCache(db, SHEET)).toBeUndefined()
    // Failed changes are not sent again on their own …
    expect((await flushOutbox(db, OWNER, async () => json(201, {}))).sent).toBe(0)
    // … only after „Erneut versuchen“, or they are given up.
    await retryEntry(db, failed?.seq as number)
    expect((await waiting(db, OWNER))[0]).toMatchObject({ status: 'pending' })
    expect((await waiting(db, OWNER))[0]?.error).toBeUndefined()
    await discardEntry(db, failed?.seq as number)
    expect(await waiting(db, OWNER)).toEqual([])
  })

  it('waits for a new sign-in and for the server after an update', async () => {
    await db.outbox.bulkAdd([entry(), entry()])
    expect(
      await flushOutbox(db, OWNER, async () => new Response(null, { status: 401 })),
    ).toMatchObject({
      needsLogin: true,
      sent: 0,
    })
    expect(
      await flushOutbox(db, OWNER, async () => new Response('busy', { status: 503 })),
    ).toMatchObject({
      interrupted: true,
    })
    const [first] = await waiting(db, OWNER)
    expect(first).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('sends only the changes of the signed-in account and accepts empty answers', async () => {
    await db.outbox.bulkAdd([entry({ owner: 'other:tenant' }), entry({ method: 'DELETE' })])
    const seen: string[] = []
    const result = await flushOutbox(db, OWNER, async (e) => {
      seen.push(e.owner)
      return new Response(null, { status: 204 })
    })
    expect(result.sent).toBe(1)
    expect(seen).toEqual([OWNER])
    expect(await waiting(db, 'other:tenant')).toHaveLength(1)
    expect(await readCache(db, SHEET)).toBeUndefined()
  })
})
