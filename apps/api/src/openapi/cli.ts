import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOpenApi, serialize } from './generate.js'

/** `pnpm openapi`: writes docs/api/openapi.json from the routes and Zod schemas. */
const here = dirname(fileURLToPath(import.meta.url))
const apiSrc = join(here, '..')
const target = join(here, '../../../../docs/api/openapi.json')
writeFileSync(target, serialize(buildOpenApi(apiSrc, '1')))
console.log(`OpenAPI written to ${target}`)
