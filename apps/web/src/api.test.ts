import { afterEach, describe, expect, it, vi } from 'vitest'

const queued: string[] = []
vi.mock('./offline/client', () => ({
  cachedGet: vi.fn(),
  hasWaitingChanges: async () => false,
  localFirst: vi.fn(),
  markServerReachable: vi.fn(),
  queueChange: async (_change: unknown, key: string) => {
    queued.push(key)
    return {}
  },
  storeGet: vi.fn(),
  syncNow: async () => undefined,
}))

const { mutate } = await import('./api')

afterEach(() => vi.unstubAllGlobals())

describe('mutate', () => {
  it('queues a lost upload with the key it already sent, so the server does not store it twice', async () => {
    const sent: string[] = []
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>)['idempotency-key'] as string)
      throw new TypeError('connection reset') // the answer never arrives
    })
    const result = await mutate({
      method: 'POST',
      path: '/api/v1/reports/r1/photos/upload?filename=a.jpg',
      blob: new Blob(['jpeg']),
      resource: '/api/v1/reports/r1',
      label: 'Foto',
      optimistic: () => ({}),
    })
    expect(result.queued).toBe(true)
    expect(sent).toHaveLength(1)
    expect(queued).toEqual(sent)
  })
})
