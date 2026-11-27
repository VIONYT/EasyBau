import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildOpenApi, routesOf, serialize } from './generate.js'

const here = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '..')
const committed = join(here, '../../../../docs/api/openapi.json')

describe('OpenAPI aus Zod (C.11)', () => {
  it('reads routes, permissions and parsed schemas from the source', () => {
    const routes = routesOf(
      `app.post('/api/v1/contacts/:id/links', async (request, reply) => {
         const auth = requirePermission(request, 'contacts.write')
         const { id } = parse(idParam, request.params)
         const input = parse(linkContactRequest, request.body)
       })
       app.get('/api/v1/meta', async () => ({}))
       app.get('/healthz', async () => ({}))
       other.get('/api/v1/x', async () => ({}))`,
      'routes/contacts.ts',
    )
    expect(routes).toEqual([
      {
        method: 'post',
        path: '/api/v1/contacts/:id/links',
        file: 'routes/contacts.ts',
        permission: 'contacts.write',
        authenticated: true,
        body: 'linkContactRequest',
        query: null,
      },
      {
        method: 'get',
        path: '/api/v1/meta',
        file: 'routes/contacts.ts',
        permission: null,
        authenticated: false,
        body: null,
        query: null,
      },
    ])
  })

  it('describes request bodies and query parameters with the Zod schemas', () => {
    const doc = buildOpenApi(apiSrc, '1') as {
      paths: Record<string, Record<string, Record<string, unknown>>>
      components: { schemas: Record<string, unknown> }
    }
    const create = doc.paths['/api/v1/contacts']?.post
    expect(create?.description).toBe('Recht: `contacts.write`')
    expect(JSON.stringify(create?.requestBody)).toContain('#/components/schemas/')
    const list = doc.paths['/api/v1/contacts']?.get as { parameters: { name: string }[] }
    expect(list.parameters.map((p) => p.name)).toEqual(expect.arrayContaining(['q', 'limit']))
    expect(doc.paths['/api/v1/contacts/{id}']?.patch).toBeDefined()
    expect(doc.paths['/api/v1/auth/login']?.post?.security).toEqual([])
    expect(Object.keys(doc.paths).length).toBeGreaterThan(150)
  })

  it('docs/api/openapi.json is up to date (run `pnpm openapi`)', () => {
    expect(readFileSync(committed, 'utf8')).toBe(serialize(buildOpenApi(apiSrc, '1')))
  })
})
