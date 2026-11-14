import { describe, expect, it } from 'vitest'
import {
  easterSunday,
  FEDERAL_STATE_NAMES,
  FEDERAL_STATES,
  isFederalState,
  publicHolidays,
} from './holidays.js'

const names = (year: number, state: (typeof FEDERAL_STATES)[number]) =>
  publicHolidays(year, state).map((h) => `${h.date} ${h.name}`)

describe('Feiertage nach Bundesland', () => {
  it('computes Easter Sunday', () => {
    expect(easterSunday(2024)).toBe('2024-03-31')
    expect(easterSunday(2025)).toBe('2025-04-20')
    expect(easterSunday(2026)).toBe('2026-04-05')
    expect(easterSunday(2027)).toBe('2027-03-28')
    expect(easterSunday(2038)).toBe('2038-04-25')
    expect(easterSunday(2008)).toBe('2008-03-23')
  })

  it('has the nine nationwide holidays everywhere', () => {
    for (const state of FEDERAL_STATES) {
      const list = names(2026, state)
      expect(list).toEqual(
        expect.arrayContaining([
          '2026-01-01 Neujahr',
          '2026-04-03 Karfreitag',
          '2026-04-06 Ostermontag',
          '2026-05-01 Tag der Arbeit',
          '2026-05-14 Christi Himmelfahrt',
          '2026-05-25 Pfingstmontag',
          '2026-10-03 Tag der Deutschen Einheit',
          '2026-12-25 1. Weihnachtstag',
          '2026-12-26 2. Weihnachtstag',
        ]),
      )
      expect(FEDERAL_STATE_NAMES[state]).toBeTruthy()
    }
  })

  it('knows the regional holidays (2026)', () => {
    expect(names(2026, 'BY')).toEqual([
      '2026-01-01 Neujahr',
      '2026-01-06 Heilige Drei Könige',
      '2026-04-03 Karfreitag',
      '2026-04-06 Ostermontag',
      '2026-05-01 Tag der Arbeit',
      '2026-05-14 Christi Himmelfahrt',
      '2026-05-25 Pfingstmontag',
      '2026-06-04 Fronleichnam',
      '2026-10-03 Tag der Deutschen Einheit',
      '2026-11-01 Allerheiligen',
      '2026-12-25 1. Weihnachtstag',
      '2026-12-26 2. Weihnachtstag',
    ])
    expect(names(2026, 'SN')).toContain('2026-11-18 Buß- und Bettag')
    expect(names(2026, 'SN')).toContain('2026-10-31 Reformationstag')
    expect(names(2026, 'SL')).toContain('2026-08-15 Mariä Himmelfahrt')
    expect(names(2026, 'BB')).toEqual(
      expect.arrayContaining(['2026-04-05 Ostersonntag', '2026-05-24 Pfingstsonntag']),
    )
    expect(names(2026, 'BE')).toContain('2026-03-08 Internationaler Frauentag')
    expect(names(2026, 'MV')).toContain('2026-03-08 Internationaler Frauentag')
    expect(names(2026, 'TH')).toContain('2026-09-20 Weltkindertag')
    expect(names(2026, 'NI')).toContain('2026-10-31 Reformationstag')
    expect(names(2026, 'HE')).toHaveLength(10)
    expect(names(2026, 'NW')).toHaveLength(11)
    // Buß- und Bettag on 22 November when that is a Wednesday.
    expect(names(2023, 'SN')).toContain('2023-11-22 Buß- und Bettag')
    expect(names(2028, 'SN')).toContain('2028-11-22 Buß- und Bettag')
    expect(names(2024, 'SN')).toContain('2024-11-20 Buß- und Bettag')
  })

  it('follows the year a rule started', () => {
    expect(names(2017, 'BW')).toContain('2017-10-31 Reformationstag')
    expect(names(2018, 'BW')).not.toContain('2018-10-31 Reformationstag')
    expect(names(2017, 'NI')).toContain('2017-10-31 Reformationstag')
    expect(names(2016, 'NI')).not.toContain('2016-10-31 Reformationstag')
    expect(names(2018, 'BE')).not.toContain('2018-03-08 Internationaler Frauentag')
    expect(names(2022, 'MV')).not.toContain('2022-03-08 Internationaler Frauentag')
    expect(names(2018, 'TH')).not.toContain('2018-09-20 Weltkindertag')
    expect(names(2025, 'BE')).toContain('2025-05-08 Tag der Befreiung')
    expect(names(2026, 'BE')).not.toContain('2026-05-08 Tag der Befreiung')
  })

  it('rejects years outside the supported range and checks state codes', () => {
    expect(() => publicHolidays(1994, 'BY')).toThrow(RangeError)
    expect(() => publicHolidays(2200, 'BY')).toThrow(/1995 bis 2199/)
    expect(() => publicHolidays(2026.5, 'BY')).toThrow(RangeError)
    expect(isFederalState('BY')).toBe(true)
    expect(isFederalState('Bayern')).toBe(false)
    expect(isFederalState(null)).toBe(false)
  })
})
