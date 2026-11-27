import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse as parseSource } from '@babel/parser'
import * as schemas from '@easybau/schemas'
import { z } from 'zod'

/**
 * OpenAPI 3.1 description of the REST API (C.11), generated from the source: every
 * `app.get|post|put|patch|delete('/api/v1/…', …)` in apps/api/src, the permission it checks
 * (`requirePermission(request, '…')` / `requireAuth`) and the Zod schemas it parses
 * (`parse(schema, request.body|request.query)`) from @easybau/schemas – the single source of the
 * API contracts. Answers are documented as JSON (types in packages/schemas) and RFC 9457 problems.
 *
 * Run `pnpm openapi` after changing routes or schemas; a test fails when docs/api/openapi.json is
 * out of date.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Node = { type: string; [key: string]: unknown }

export interface RouteInfo {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  path: string
  file: string
  permission: string | null
  authenticated: boolean
  body: string | null
  query: string | null
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])

function walk(node: unknown, visit: (node: Node) => void) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const n = node as Node
  if (typeof n.type === 'string') visit(n)
  for (const [key, value] of Object.entries(n)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue
    if (value && typeof value === 'object') walk(value, visit)
  }
}

const isMember = (node: unknown, object: string, property: string) => {
  const n = node as Node | undefined
  return (
    n?.type === 'MemberExpression' &&
    (n.object as Node).type === 'Identifier' &&
    (n.object as { name: string }).name === object &&
    (n.property as { name?: string }).name === property
  )
}

/** Routes of one source file. */
export function routesOf(source: string, file: string): RouteInfo[] {
  const ast = parseSource(source, { sourceType: 'module', plugins: ['typescript'] })
  const routes: RouteInfo[] = []
  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee as Node
    if (callee.type !== 'MemberExpression') return
    const method = (callee.property as { name?: string }).name ?? ''
    if (!METHODS.has(method) || (callee.object as { name?: string }).name !== 'app') return
    const [first, ...rest] = node.arguments as Node[]
    if (first?.type !== 'StringLiteral') return
    const path = (first as unknown as { value: string }).value
    if (!path.startsWith('/api/')) return
    const handler = rest.at(-1)
    const route: RouteInfo = {
      method: method as RouteInfo['method'],
      path,
      file,
      permission: null,
      authenticated: false,
      body: null,
      query: null,
    }
    walk(handler, (inner) => {
      if (inner.type !== 'CallExpression') return
      const name = (inner.callee as { name?: string }).name
      const args = inner.arguments as Node[]
      if (name === 'requirePermission' && args[1]?.type === 'StringLiteral') {
        route.permission ??= (args[1] as unknown as { value: string }).value
        route.authenticated = true
      } else if (name === 'requireAuth') {
        route.authenticated = true
      } else if (name === 'parse' && args[0]?.type === 'Identifier') {
        const schema = (args[0] as unknown as { name: string }).name
        if (isMember(args[1], 'request', 'body')) route.body ??= schema
        if (isMember(args[1], 'request', 'query')) route.query ??= schema
      }
    })
    routes.push(route)
  })
  return routes
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'testing' ? [] : sourceFiles(full)
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : []
    })
    .sort()
}

const schemaOf = (name: string): z.ZodType | null => {
  const value = (schemas as Record<string, unknown>)[name]
  return value instanceof z.ZodType ? value : null
}

function jsonSchema(schema: z.ZodType): Record<string, Json> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    target: 'draft-2020-12',
  }) as Record<string, Json>
  return rest
}

const PROBLEM: Record<string, Json> = {
  type: 'object',
  description:
    'RFC 9457 Problem Details; `detail` ist deutsch, `errors` enthält Meldungen je Feld.',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    errors: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['title', 'status'],
}

/** The OpenAPI document for all routes under `apiSrc` (apps/api/src). */
export function buildOpenApi(apiSrc: string, version: string): Record<string, Json> {
  const routes = sourceFiles(apiSrc).flatMap((file) =>
    routesOf(readFileSync(file, 'utf8'), relative(apiSrc, file).replaceAll('\\', '/')),
  )
  const components: Record<string, Json> = { ProblemDetails: PROBLEM }
  const ref = (name: string): Json => {
    const schema = schemaOf(name)
    if (!schema) return { type: 'object', description: `lokales Schema ${name}` }
    components[name] ??= jsonSchema(schema)
    return { $ref: `#/components/schemas/${name}` }
  }
  const paths: Record<string, Record<string, Json>> = {}
  for (const route of [...routes].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  )) {
    const openPath = route.path.replace(/:([A-Za-z]+)/g, '{$1}')
    const parameters: Json[] = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({
      name: m[1] as string,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }))
    if (route.query) {
      const schema = schemaOf(route.query)
      const json = schema ? jsonSchema(schema) : null
      const properties = (json?.properties ?? {}) as Record<string, Json>
      const required = new Set((json?.required ?? []) as string[])
      for (const [name, property] of Object.entries(properties)) {
        parameters.push({ name, in: 'query', required: required.has(name), schema: property })
      }
    }
    const operation: Record<string, Json> = {
      operationId: `${route.method}${openPath.replace(/[^A-Za-z0-9]+(.)?/g, (_, c?: string) => (c ? c.toUpperCase() : ''))}`,
      tags: [route.file.replace(/^routes\//, '').replace(/\.ts$/, '')],
      ...(route.permission
        ? { description: `Recht: \`${route.permission}\`` }
        : route.authenticated
          ? { description: 'Angemeldet' }
          : {}),
      ...(route.authenticated ? {} : { security: [] }),
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(route.body) } },
            },
          }
        : {}),
      responses: {
        '2XX': { description: 'Erfolg (JSON, Typen in packages/schemas)' },
        default: {
          description: 'Fehler',
          content: {
            'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
          },
        },
      },
    }
    paths[openPath] ??= {}
    ;(paths[openPath] as Record<string, Json>)[route.method] = operation
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'EasyBau API',
      version,
      description:
        'REST-API von EasyBau (/api/v1). Anmeldung per Sitzungs-Cookie (HttpOnly); ändernde Anfragen nur von derselben Herkunft (CSRF), POST mit optionalem Idempotency-Key, PATCH mit If-Match (ETag). Erzeugt aus dem Quelltext (apps/api/src/openapi/generate.ts).',
      license: { name: 'AGPL-3.0-or-later', identifier: 'AGPL-3.0-or-later' },
    },
    servers: [{ url: '/' }],
    security: [{ session: [] }],
    paths: paths as Json,
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: '__Host-sid' } },
      schemas: Object.fromEntries(
        Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
  }
}

/** Pretty JSON with a trailing newline, as committed in docs/api/openapi.json. */
export const serialize = (document: Record<string, Json>) =>
  `${JSON.stringify(document, null, 2)}\n`
