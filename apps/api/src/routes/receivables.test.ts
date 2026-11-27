import { describe, expect, it } from 'vitest'
import { startAfter } from './receivables.js'

// In list order: date desc, number desc (drafts without number first), id desc.
const items = [
  { documentDate: '2026-11-20', number: null, id: 'b' },
  { documentDate: '2026-11-20', number: 'RE-2026-0012', id: 'a' },
  { documentDate: '2026-11-20', number: 'RE-2026-0011', id: 'c' },
  { documentDate: '2026-11-03', number: 'RE-2026-0010', id: 'd' },
]

describe('invoice list paging', () => {
  it('continues after the cursor invoice', () => {
    expect(startAfter(items, ['2026-11-20', null, 'b'])).toBe(1)
    expect(startAfter(items, ['2026-11-20', 'RE-2026-0012', 'a'])).toBe(2)
    expect(startAfter(items, ['2026-11-03', 'RE-2026-0010', 'd'])).toBe(4)
  })

  it('continues at the right place when the cursor invoice left the filter', () => {
    // RE-2026-0011 was paid meanwhile and is no longer in the "overdue" list.
    const filtered = items.filter((i) => i.id !== 'c')
    expect(startAfter(filtered, ['2026-11-20', 'RE-2026-0011', 'c'])).toBe(2)
    expect(filtered[2]?.id).toBe('d')
  })
})
