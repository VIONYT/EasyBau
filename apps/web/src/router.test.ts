import { describe, expect, it } from 'vitest'
import { parseRoute, pathOf } from './router'

const ID = '0195f3c4-0000-7000-8000-000000000003'

describe('router', () => {
  it('gives a contact its own URL and keeps the list URL', () => {
    expect(parseRoute(`/kontakte/${ID}`)).toEqual({ view: 'contacts', id: ID })
    expect(parseRoute('/kontakte')).toEqual({ view: 'contacts' })
    expect(parseRoute('/kontakte/kein-uuid')).toEqual({ view: 'contacts' })
    expect(pathOf({ view: 'contacts', id: ID })).toBe(`/kontakte/${ID}`)
    expect(pathOf({ view: 'contacts' })).toBe('/kontakte')
  })
})
