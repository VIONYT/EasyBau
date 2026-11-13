/**
 * Gesetzliche Feiertage in Deutschland je Bundesland (P2.11). Computed, never stored: the
 * company only stores its own additions (Betriebsruhe, örtliche Feiertage). Only holidays that
 * apply in the whole state are included; local ones (Fronleichnam in parts of Sachsen/Thüringen,
 * Mariä Himmelfahrt in Bayern, Augsburger Friedensfest) are added by the company.
 */

export const FEDERAL_STATES = [
  'BW',
  'BY',
  'BE',
  'BB',
  'HB',
  'HH',
  'HE',
  'MV',
  'NI',
  'NW',
  'RP',
  'SL',
  'SN',
  'ST',
  'SH',
  'TH',
] as const
export type FederalState = (typeof FEDERAL_STATES)[number]

export const FEDERAL_STATE_NAMES: Record<FederalState, string> = {
  BW: 'Baden-Württemberg',
  BY: 'Bayern',
  BE: 'Berlin',
  BB: 'Brandenburg',
  HB: 'Bremen',
  HH: 'Hamburg',
  HE: 'Hessen',
  MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen',
  NW: 'Nordrhein-Westfalen',
  RP: 'Rheinland-Pfalz',
  SL: 'Saarland',
  SN: 'Sachsen',
  ST: 'Sachsen-Anhalt',
  SH: 'Schleswig-Holstein',
  TH: 'Thüringen',
}

export interface PublicHoliday {
  /** ISO date YYYY-MM-DD */
  date: string
  name: string
}

/** Years with today's rules (the 1995 Pflegeversicherung reform removed Buß- und Bettag). */
export const HOLIDAY_YEARS = { from: 1995, to: 2199 } as const

const iso = (d: Date) => d.toISOString().slice(0, 10)
const day = (year: number, month: number, date: number) => new Date(Date.UTC(year, month - 1, date))
const plus = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000)

/** Easter Sunday (Gregorian calendar, anonymous algorithm by Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const date = ((h + l - 7 * m + 114) % 31) + 1
  return iso(day(year, month, date))
}

export function isFederalState(value: unknown): value is FederalState {
  return typeof value === 'string' && (FEDERAL_STATES as readonly string[]).includes(value)
}

/** Statutory public holidays of a year in a state, sorted by date. */
export function publicHolidays(year: number, state: FederalState): PublicHoliday[] {
  if (!Number.isInteger(year) || year < HOLIDAY_YEARS.from || year > HOLIDAY_YEARS.to) {
    throw new RangeError(
      `Feiertage gibt es für die Jahre ${HOLIDAY_YEARS.from} bis ${HOLIDAY_YEARS.to}.`,
    )
  }
  const in_ = (...states: FederalState[]) => states.includes(state)
  const easter = new Date(`${easterSunday(year)}T00:00:00Z`)
  const list: [Date, string, boolean][] = [
    [day(year, 1, 1), 'Neujahr', true],
    [day(year, 1, 6), 'Heilige Drei Könige', in_('BW', 'BY', 'ST')],
    [
      day(year, 3, 8),
      'Internationaler Frauentag',
      (state === 'BE' && year >= 2019) || (state === 'MV' && year >= 2023),
    ],
    [plus(easter, -2), 'Karfreitag', true],
    [easter, 'Ostersonntag', in_('BB')],
    [plus(easter, 1), 'Ostermontag', true],
    [day(year, 5, 1), 'Tag der Arbeit', true],
    [day(year, 5, 8), 'Tag der Befreiung', state === 'BE' && (year === 2020 || year === 2025)],
    [plus(easter, 39), 'Christi Himmelfahrt', true],
    [plus(easter, 49), 'Pfingstsonntag', in_('BB')],
    [plus(easter, 50), 'Pfingstmontag', true],
    [plus(easter, 60), 'Fronleichnam', in_('BW', 'BY', 'HE', 'NW', 'RP', 'SL')],
    [day(year, 8, 15), 'Mariä Himmelfahrt', in_('SL')],
    [day(year, 9, 20), 'Weltkindertag', state === 'TH' && year >= 2019],
    [day(year, 10, 3), 'Tag der Deutschen Einheit', true],
    [
      day(year, 10, 31),
      'Reformationstag',
      year === 2017 ||
        in_('BB', 'MV', 'SN', 'ST', 'TH') ||
        (year >= 2018 && in_('HB', 'HH', 'NI', 'SH')),
    ],
    [day(year, 11, 1), 'Allerheiligen', in_('BW', 'BY', 'NW', 'RP', 'SL')],
    // Wednesday before 23 November.
    [
      plus(day(year, 11, 22), -((day(year, 11, 22).getUTCDay() + 4) % 7)),
      'Buß- und Bettag',
      in_('SN'),
    ],
    [day(year, 12, 25), '1. Weihnachtstag', true],
    [day(year, 12, 26), '2. Weihnachtstag', true],
  ]
  return list
    .filter(([, , applies]) => applies)
    .map(([date, name]) => ({ date: iso(date), name }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
