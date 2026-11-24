import { describe, expect, it } from 'vitest'
import { erasureAction } from './privacy.js'

describe('erasureAction', () => {
  it('erases at once without retained records or after the period', () => {
    expect(erasureAction(null, '2026-11-24')).toEqual({ action: 'erase' })
    expect(erasureAction('2026-11-23', '2026-11-24')).toEqual({ action: 'erase' })
  })

  it('blocks until the end of the retention period (last day included)', () => {
    expect(erasureAction('2026-11-24', '2026-11-24')).toEqual({
      action: 'block',
      until: '2026-11-24',
    })
    expect(erasureAction('2036-12-31', '2026-11-24')).toEqual({
      action: 'block',
      until: '2036-12-31',
    })
  })
})
