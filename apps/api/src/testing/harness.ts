import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSql, migrate, type Sql } from '@opc/db'
import { FsObjectStore } from '@opc/storage'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { buildApi } from '../index.js'

/** Test harness: a fresh database per test file and an API instance talking to it. */
export interface Harness {
  app: FastifyInstance
  adminSql: Sql
  sql: Sql
  setupToken: string
  clock: { now: number }
  /** Directory of the file store used by this API instance. */
  storageDir: string
  close: () => Promise<void>
}

export async function createHarness(
  options: { requireAdminMfa?: boolean; uploadMaxMb?: number } = {},
): Promise<Harness> {
  const baseUrl = process.env.DATABASE_URL as string
  const root = createSql({ DATABASE_URL: baseUrl, DATABASE_POOL_MAX: 1 }, { mode: 'admin' })
  const name = `opc_api_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  await root.unsafe(`create database ${name}`)
  const url = new URL(baseUrl)
  url.pathname = `/${name}`
  const adminSql = createSql(
    { DATABASE_URL: url.toString(), DATABASE_POOL_MAX: 2 },
    { mode: 'admin' },
  )
  await migrate(adminSql)
  const sql = createSql({ DATABASE_URL: url.toString(), DATABASE_POOL_MAX: 5 })
  const clock = { now: Date.parse('2026-11-08T10:00:00Z') }
  const setupToken = 'TEST-SETU-PTOK'
  const storageDir = await mkdtemp(join(tmpdir(), 'opc-files-'))
  const app = buildApi({
    config: {
      APP_NAME: 'Test-ERP',
      APP_VERSION: 'test',
      APP_ROLE: 'all',
      PROFILE: 'compact',
      APP_SECRET: 'z'.repeat(40),
      COOKIE_SECURE: false,
      REQUIRE_ADMIN_MFA: options.requireAdminMfa ?? true,
      UPLOAD_MAX_MB: options.uploadMaxMb ?? 50,
    },
    storage: new FsObjectStore(storageDir),
    isReady: async () => true,
    sql,
    setupToken,
    now: () => clock.now,
  })
  await app.ready()
  return {
    app,
    adminSql,
    sql,
    setupToken,
    clock,
    storageDir,
    close: async () => {
      await rm(storageDir, { recursive: true, force: true })
      await app.close()
      await sql.end({ timeout: 5 })
      await adminSql.end({ timeout: 5 })
      await root.unsafe(`drop database if exists ${name} with (force)`)
      await root.end()
    },
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** A browser-like client that keeps cookies (session and challenge) between requests. */
export class Client {
  private readonly cookies = new Map<string, string>()

  constructor(private readonly app: FastifyInstance) {}

  async request(method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    const res: LightMyRequestResponse = await this.app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    })
    for (const c of res.cookies) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0)) this.cookies.delete(c.name)
      else this.cookies.set(c.name, c.value)
    }
    return res
  }

  get = (url: string) => this.request('GET', url)
  post = (url: string, body: unknown = {}, headers?: Record<string, string>) =>
    this.request('POST', url, body, headers)
  patch = (url: string, body: unknown) => this.request('PATCH', url, body)
  delete = (url: string) => this.request('DELETE', url)
  /** Raw upload like the web app does it (application/octet-stream, metadata in the query). */
  upload = (url: string, content: Buffer, headers: Record<string, string> = {}) =>
    this.request('POST', url, content, { 'content-type': 'application/octet-stream', ...headers })

  has(cookie: string): boolean {
    return this.cookies.has(cookie)
  }
}
