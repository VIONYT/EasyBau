/** Date formatting that never throws on unexpected input (a crash would blank the whole app). */
export function formatDateTime(
  iso: string | null | undefined,
  style: 'date' | 'datetime' = 'datetime',
): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(
    'de-DE',
    style === 'date' ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' },
  ).format(date)
}
