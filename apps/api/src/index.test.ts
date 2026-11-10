import { describe, expect, it } from 'vitest'
import { buildApi } from './index.js'

const config = {
  APP_NAME: 'Test-ERP',
  APP_VERSION: '1.2.3',
  APP_ROLE: 'all',
  PROFILE: 'compact',
} as const

describe('api', () => {
  it('reports liveness without touching dependencies', async () => {
    const app = buildApi({ config, isReady: () => Promise.reject(new Error('must not be called')) })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('reports ready when the database answers', async () => {
    const app = buildApi({ config, isReady: async () => true })
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 503 problem details when the database is down', async () => {
    const app = buildApi({ config, isReady: async () => false })
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json()).toMatchObject({ status: 503, title: 'Service Unavailable' })
  })

  it('exposes application metadata', async () => {
    const app = buildApi({ config, isReady: async () => true })
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta' })
    expect(res.json()).toEqual({
      name: 'Test-ERP',
      version: '1.2.3',
      profile: 'compact',
      role: 'all',
    })
  })

  it('answers unknown routes with German problem details', async () => {
    const app = buildApi({ config, isReady: async () => true })
    const res = await app.inject({ method: 'GET', url: '/api/v1/unknown' })
    expect(res.statusCode).toBe(404)
    expect(res.json().detail).toMatch(/nicht gefunden/)
  })
})
