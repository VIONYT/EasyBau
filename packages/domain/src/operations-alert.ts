/**
 * Betriebswarnung per E-Mail: which operational problems an installation has, and when the people
 * responsible get an e-mail about them. Pure logic; the worker gathers the facts and sends.
 */

const HOUR_MS = 60 * 60 * 1000

/** A nightly backup older than this is missing (one night plus some slack). */
export const BACKUP_MAX_AGE_HOURS = 26
/** The nightly audit chain check (02:17) must have run within this time. */
export const AUDIT_MAX_AGE_HOURS = 26
/** Originals waiting longer than this for the archive mean it does not keep up. */
export const ARCHIVE_PENDING_MAX_HOURS = 24
/** A problem that stays is reported again after this many days. */
export const ALERT_REPEAT_DAYS = 7

export interface OperationsFacts {
  now: Date
  backup: {
    lastSuccessAt: string | null
    latest: {
      status: 'ok' | 'failed'
      finishedAt: string
      message: string | null
      offsite: { status: 'ok' | 'failed' | 'off'; message: string | null } | null
    } | null
  }
  audit: {
    lastCheckAt: string | null
    problem: string | null
  }
  archive: {
    configured: boolean
    /** Originals whose copy into the archive failed at least once and is still missing. */
    failing: number
    lastError: string | null
    oldestPendingAt: string | null
    /** Archived originals that are lost (no intact copy anywhere). */
    lost: number
  }
}

export type OperationsProblemKey =
  | 'backup_none'
  | 'backup_old'
  | 'backup_failed'
  | 'offsite_failed'
  | 'audit_never'
  | 'audit_stale'
  | 'audit_broken'
  | 'archive_failing'
  | 'archive_stuck'
  | 'archive_lost'

export interface OperationsProblem {
  key: OperationsProblemKey
  /** German text for the e-mail. */
  text: string
}

const olderThan = (iso: string | null, hours: number, now: Date) =>
  iso === null || now.getTime() - Date.parse(iso) > hours * HOUR_MS

const withDetail = (text: string, detail: string | null | undefined) =>
  detail?.trim() ? `${text} (${detail.trim()})` : text

/** The problems worth an e-mail, in a fixed order. „Sicherung außer Haus aus“ is no problem here. */
export function operationsProblems(facts: OperationsFacts): OperationsProblem[] {
  const { now, backup, audit, archive } = facts
  const problems: OperationsProblem[] = []

  if (backup.lastSuccessAt === null) {
    problems.push({
      key: 'backup_none',
      text: 'Es gibt noch keine erfolgreiche Sicherung. Bitte den Dienst „backup“ prüfen.',
    })
  } else if (olderThan(backup.lastSuccessAt, BACKUP_MAX_AGE_HOURS, now)) {
    problems.push({
      key: 'backup_old',
      text: `Die letzte erfolgreiche Sicherung ist älter als ${BACKUP_MAX_AGE_HOURS} Stunden.`,
    })
  }
  if (backup.latest?.status === 'failed') {
    problems.push({
      key: 'backup_failed',
      text: withDetail('Die letzte Sicherung ist fehlgeschlagen', backup.latest.message),
    })
  } else if (backup.latest?.offsite?.status === 'failed') {
    problems.push({
      key: 'offsite_failed',
      text: withDetail(
        'Die verschlüsselte Kopie außer Haus ist fehlgeschlagen; die lokale Sicherung ist vorhanden',
        backup.latest.offsite.message,
      ),
    })
  }

  if (audit.problem !== null) {
    problems.push({
      key: 'audit_broken',
      text: `Die Prüfung des Änderungsprotokolls meldet ein Problem („${audit.problem}“). Bitte unter Prüfung › Audit-Kette ansehen.`,
    })
  } else if (audit.lastCheckAt === null) {
    problems.push({
      key: 'audit_never',
      text: 'Das Änderungsprotokoll wurde noch nie geprüft (nächtlicher Hintergrunddienst läuft nicht?).',
    })
  } else if (olderThan(audit.lastCheckAt, AUDIT_MAX_AGE_HOURS, now)) {
    problems.push({
      key: 'audit_stale',
      text: `Das Änderungsprotokoll wurde seit über ${AUDIT_MAX_AGE_HOURS} Stunden nicht geprüft.`,
    })
  }

  if (archive.configured) {
    if (archive.lost > 0) {
      problems.push({
        key: 'archive_lost',
        text: `${archive.lost} archivierte Belege sind im Belegarchiv verloren und konnten nicht wiederhergestellt werden.`,
      })
    }
    if (archive.failing > 0) {
      problems.push({
        key: 'archive_failing',
        text: withDetail(
          `${archive.failing} Belege konnten nicht ins Belegarchiv kopiert werden`,
          archive.lastError,
        ),
      })
    } else if (
      archive.oldestPendingAt !== null &&
      olderThan(archive.oldestPendingAt, ARCHIVE_PENDING_MAX_HOURS, now)
    ) {
      problems.push({
        key: 'archive_stuck',
        text: `Belege warten seit über ${ARCHIVE_PENDING_MAX_HOURS} Stunden auf die Archivierung.`,
      })
    }
  }
  return problems
}

export interface PreviousAlert {
  problems: string[]
  sentAt: string
}

/**
 * When to write: a new problem → at once; problems that stay → again after ALERT_REPEAT_DAYS;
 * everything fine again after a warning → once „wieder in Ordnung“.
 */
export function alertDecision(
  previous: PreviousAlert | null,
  problems: readonly OperationsProblem[],
  now: Date,
): 'alert' | 'resolved' | null {
  const keys = problems.map((p) => p.key)
  if (keys.length === 0) return previous && previous.problems.length > 0 ? 'resolved' : null
  if (!previous) return 'alert'
  if (keys.some((key) => !previous.problems.includes(key))) return 'alert'
  return olderThan(previous.sentAt, ALERT_REPEAT_DAYS * 24, now) ? 'alert' : null
}

/** Subject and plain text of the e-mail. */
export function alertMail(
  kind: 'alert' | 'resolved',
  context: { appName: string; company: string; problems: readonly OperationsProblem[] },
): { subject: string; text: string } {
  if (kind === 'resolved') {
    return {
      subject: `${context.appName}: Betrieb wieder in Ordnung (${context.company})`,
      text: [
        'Guten Tag,',
        '',
        `die zuletzt gemeldeten Probleme im Betrieb von ${context.appName} sind behoben: Sicherung, Änderungsprotokoll und Belegarchiv sind in Ordnung.`,
        '',
        'Diese Nachricht wurde automatisch erstellt.',
      ].join('\n'),
    }
  }
  return {
    subject: `${context.appName}: Bitte Betrieb prüfen (${context.company})`,
    text: [
      'Guten Tag,',
      '',
      `der tägliche Betriebs-Check von ${context.appName} hat Folgendes gefunden:`,
      '',
      ...context.problems.map((p) => `- ${p.text}`),
      '',
      'Details stehen unter Einstellungen › Betrieb (Betriebs-Check). Hilfe zur Behebung: Betriebsdokumentation, Abschnitt Sicherung und Belegarchiv.',
      `Solange die Probleme bestehen, kommt diese Nachricht alle ${ALERT_REPEAT_DAYS} Tage erneut, bei neuen Problemen sofort.`,
      '',
      'Diese Nachricht wurde automatisch erstellt.',
    ].join('\n'),
  }
}
