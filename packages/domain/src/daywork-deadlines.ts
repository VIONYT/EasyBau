/**
 * Fristen für Stundenlohnzettel (Regieberichte) nach VOB/B § 15 Abs. 3:
 * - Einreichen „je nach Verkehrssitte werktäglich oder wöchentlich“ – hier wöchentlich: spätestens am
 *   ersten Arbeitstag nach der Woche, in der die Arbeit ausgeführt wurde.
 * - Der Auftraggeber gibt sie „unverzüglich, spätestens jedoch innerhalb von 6 Werktagen nach
 *   Zugang“ bescheinigt zurück; nicht fristgemäß zurückgegebene gelten als anerkannt (Satz 5).
 * Werktage sind Montag bis Samstag ohne Feiertage. Fällt das Fristende auf einen Samstag, Sonntag oder
 * Feiertag, endet die Frist am nächsten Werktag, der kein Samstag ist (§ 193 BGB).
 * Hinweis, keine Rechtsberatung: abweichende Vereinbarungen im Vertrag gehen vor.
 */

export type DayworkState =
  | 'to_submit'
  | 'submit_overdue'
  | 'waiting'
  | 'deemed_accepted'
  | 'returned'

export interface DayworkDeadline {
  state: DayworkState
  /** Last day to hand the report to the client (null once handed over). */
  submitBy: string | null
  /** Last day for the client to return it (null until handed over). */
  returnBy: string | null
}

const DAY = 86_400_000
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`)
const toIso = (date: Date) => date.toISOString().slice(0, 10)
const plusDays = (iso: string, days: number) => toIso(new Date(toDate(iso).getTime() + days * DAY))
/** 0 = Sunday … 6 = Saturday */
const weekday = (iso: string) => toDate(iso).getUTCDay()

/** Werktag: Monday to Saturday and not a holiday. */
export function isWorkingDay(iso: string, holidays: ReadonlySet<string>): boolean {
  return weekday(iso) !== 0 && !holidays.has(iso)
}

/** End of a period per § 193 BGB: Saturdays, Sundays and holidays move to the next day. */
export function deadlineEnd(iso: string, holidays: ReadonlySet<string>): string {
  let day = iso
  while (weekday(day) === 6 || !isWorkingDay(day, holidays)) day = plusDays(day, 1)
  return day
}

/** The day `count` Werktage after `iso` (the day itself does not count). */
export function addWorkingDays(iso: string, count: number, holidays: ReadonlySet<string>): string {
  let day = iso
  for (let left = count; left > 0; ) {
    day = plusDays(day, 1)
    if (isWorkingDay(day, holidays)) left -= 1
  }
  return day
}

export function dayworkDeadline(input: {
  /** Day the work was done (end of the Leistungszeitraum, else the report date). */
  performedOn: string
  /** Day the report reached the client; null while not handed over. */
  submittedOn: string | null
  /** Signed by the client (bescheinigt zurück). */
  returned: boolean
  today: string
  holidays: ReadonlySet<string>
}): DayworkDeadline {
  const { performedOn, submittedOn, holidays, today } = input
  if (input.returned) return { state: 'returned', submitBy: null, returnBy: null }
  if (!submittedOn) {
    // First day after the week (Monday to Sunday) of the work, moved past holidays.
    const nextMonday = plusDays(performedOn, (8 - weekday(performedOn)) % 7 || 7)
    const submitBy = deadlineEnd(nextMonday, holidays)
    return { state: today > submitBy ? 'submit_overdue' : 'to_submit', submitBy, returnBy: null }
  }
  const returnBy = deadlineEnd(addWorkingDays(submittedOn, 6, holidays), holidays)
  return { state: today > returnBy ? 'deemed_accepted' : 'waiting', submitBy: null, returnBy }
}
