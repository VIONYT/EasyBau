import { describe, expect, it } from 'vitest'
import { addWorkingDays, dayworkDeadline, deadlineEnd, isWorkingDay } from './daywork-deadlines.js'

const none = new Set<string>()

describe('Fristen für Stundenlohnzettel (VOB/B § 15 Abs. 3)', () => {
  it('counts Monday to Saturday without holidays as Werktage', () => {
    expect(isWorkingDay('2026-11-14', none)).toBe(true) // Saturday
    expect(isWorkingDay('2026-11-15', none)).toBe(false) // Sunday
    expect(isWorkingDay('2026-12-25', new Set(['2026-12-25']))).toBe(false)
    // Monday 2026-11-16 + 6 Werktage = Monday 2026-11-23 (Saturday counts, Sunday not).
    expect(addWorkingDays('2026-11-16', 6, none)).toBe('2026-11-23')
    expect(addWorkingDays('2026-11-16', 6, new Set(['2026-11-18']))).toBe('2026-11-24')
  })

  it('moves a deadline on a Saturday, Sunday or holiday to the next working day (§ 193 BGB)', () => {
    expect(deadlineEnd('2026-11-13', none)).toBe('2026-11-13')
    expect(deadlineEnd('2026-11-14', none)).toBe('2026-11-16')
    expect(deadlineEnd('2026-12-24', new Set(['2026-12-25', '2026-12-26']))).toBe('2026-12-24')
    expect(deadlineEnd('2026-12-25', new Set(['2026-12-25', '2026-12-26']))).toBe('2026-12-28')
  })

  it('expects the report in the first working day after the week of the work', () => {
    // Work on Wednesday 2026-11-11 → hand over by Monday 2026-11-16.
    const base = { performedOn: '2026-11-11', submittedOn: null, returned: false, holidays: none }
    expect(dayworkDeadline({ ...base, today: '2026-11-16' })).toEqual({
      state: 'to_submit',
      submitBy: '2026-11-16',
      returnBy: null,
    })
    expect(dayworkDeadline({ ...base, today: '2026-11-17' }).state).toBe('submit_overdue')
    // Work on a Sunday belongs to that week; Monday after Easter is a holiday.
    expect(
      dayworkDeadline({
        ...base,
        performedOn: '2026-04-05',
        today: '2026-04-01',
        holidays: new Set(['2026-04-06']),
      }).submitBy,
    ).toBe('2026-04-07')
    // Work on a Monday: the next Monday.
    expect(
      dayworkDeadline({ ...base, performedOn: '2026-11-16', today: '2026-11-16' }).submitBy,
    ).toBe('2026-11-23')
  })

  it('gives the client 6 Werktage; afterwards the report counts as accepted', () => {
    const base = {
      performedOn: '2026-11-11',
      submittedOn: '2026-11-12',
      returned: false,
      holidays: none,
    }
    // Thursday 12.11. + 6 Werktage = Thursday 19.11.
    expect(dayworkDeadline({ ...base, today: '2026-11-19' })).toEqual({
      state: 'waiting',
      submitBy: null,
      returnBy: '2026-11-19',
    })
    expect(dayworkDeadline({ ...base, today: '2026-11-20' }).state).toBe('deemed_accepted')
    // Handed over on Monday: the 6th Werktag is a Saturday → Monday.
    expect(
      dayworkDeadline({ ...base, submittedOn: '2026-11-16', today: '2026-11-16' }).returnBy,
    ).toBe('2026-11-23')
    expect(
      dayworkDeadline({ ...base, submittedOn: '2026-11-09', today: '2026-11-09' }).returnBy,
    ).toBe('2026-11-16')
    expect(dayworkDeadline({ ...base, returned: true, today: '2026-12-01' })).toEqual({
      state: 'returned',
      submitBy: null,
      returnBy: null,
    })
  })
})
