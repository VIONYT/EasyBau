import { describe, expect, it } from 'vitest'
import {
  ALERT_REPEAT_DAYS,
  alertDecision,
  alertMail,
  type OperationsFacts,
  operationsProblems,
} from './operations-alert.js'

const now = new Date('2026-11-24T06:43:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString()

const healthy = (): OperationsFacts => ({
  now,
  backup: {
    lastSuccessAt: hoursAgo(4),
    latest: {
      status: 'ok',
      finishedAt: hoursAgo(4),
      message: null,
      offsite: { status: 'ok', message: null },
    },
  },
  audit: { lastCheckAt: hoursAgo(4), problem: null },
  archive: { configured: true, failing: 0, lastError: null, oldestPendingAt: null, lost: 0 },
})

const keys = (facts: OperationsFacts) => operationsProblems(facts).map((p) => p.key)

describe('operationsProblems', () => {
  it('finds nothing in a healthy installation, also without archive or off-site copy', () => {
    expect(keys(healthy())).toEqual([])
    const f = healthy()
    f.archive = {
      configured: false,
      failing: 3,
      lastError: 'x',
      oldestPendingAt: hoursAgo(99),
      lost: 2,
    }
    f.backup.latest = { status: 'ok', finishedAt: hoursAgo(4), message: null, offsite: null }
    expect(keys(f)).toEqual([])
    f.backup.latest.offsite = { status: 'off', message: null }
    expect(keys(f)).toEqual([])
  })

  it('reports missing, old and failed backups and a failed off-site copy', () => {
    const none = healthy()
    none.backup = { lastSuccessAt: null, latest: null }
    expect(operationsProblems(none)[0]?.text).toMatch(/noch keine erfolgreiche Sicherung/)

    const old = healthy()
    old.backup.lastSuccessAt = hoursAgo(30)
    old.backup.latest = {
      status: 'failed',
      finishedAt: hoursAgo(3),
      message: 'Datenträger voll',
      offsite: null,
    }
    expect(operationsProblems(old).map((p) => p.text)).toEqual([
      'Die letzte erfolgreiche Sicherung ist älter als 26 Stunden.',
      'Die letzte Sicherung ist fehlgeschlagen (Datenträger voll)',
    ])

    const offsite = healthy()
    offsite.backup.latest = {
      status: 'ok',
      finishedAt: hoursAgo(4),
      message: null,
      offsite: { status: 'failed', message: '  ' },
    }
    expect(operationsProblems(offsite).map((p) => p.text)).toEqual([
      'Die verschlüsselte Kopie außer Haus ist fehlgeschlagen; die lokale Sicherung ist vorhanden',
    ])
  })

  it('reports the audit chain: broken, never checked, check too old', () => {
    const f = healthy()
    f.audit = { lastCheckAt: hoursAgo(2), problem: 'broken' }
    expect(operationsProblems(f)[0]?.text).toMatch(/Problem \(„broken“\)/)
    f.audit = { lastCheckAt: null, problem: null }
    expect(keys(f)).toEqual(['audit_never'])
    f.audit = { lastCheckAt: hoursAgo(27), problem: null }
    expect(keys(f)).toEqual(['audit_stale'])
  })

  it('reports lost, failing and stuck archive copies', () => {
    const f = healthy()
    f.archive = {
      configured: true,
      failing: 2,
      lastError: 'S3 nicht erreichbar',
      oldestPendingAt: hoursAgo(30),
      lost: 1,
    }
    expect(operationsProblems(f).map((p) => p.text)).toEqual([
      '1 archivierte Belege sind im Belegarchiv verloren und konnten nicht wiederhergestellt werden.',
      '2 Belege konnten nicht ins Belegarchiv kopiert werden (S3 nicht erreichbar)',
    ])
    f.archive = {
      configured: true,
      failing: 0,
      lastError: null,
      oldestPendingAt: hoursAgo(25),
      lost: 0,
    }
    expect(keys(f)).toEqual(['archive_stuck'])
    f.archive.oldestPendingAt = hoursAgo(2)
    expect(keys(f)).toEqual([])
  })
})

describe('alertDecision', () => {
  const problem = (key: 'backup_old' | 'audit_stale') => ({ key, text: key })

  it('writes at once for new problems, repeats after a week, reports the all clear once', () => {
    expect(alertDecision(null, [], now)).toBeNull()
    expect(alertDecision({ problems: [], sentAt: hoursAgo(1) }, [], now)).toBeNull()
    expect(alertDecision(null, [problem('backup_old')], now)).toBe('alert')
    const sent = { problems: ['backup_old'], sentAt: hoursAgo(24) }
    expect(alertDecision(sent, [problem('backup_old')], now)).toBeNull()
    expect(alertDecision(sent, [problem('backup_old'), problem('audit_stale')], now)).toBe('alert')
    const weekOld = { problems: ['backup_old'], sentAt: hoursAgo(ALERT_REPEAT_DAYS * 24 + 1) }
    expect(alertDecision(weekOld, [problem('backup_old')], now)).toBe('alert')
    expect(alertDecision(sent, [], now)).toBe('resolved')
  })
})

describe('alertMail', () => {
  it('lists the problems and points to the Betriebs-Check', () => {
    const mail = alertMail('alert', {
      appName: 'EasyBau',
      company: 'Muster Bau GmbH',
      problems: [{ key: 'backup_old', text: 'Sicherung zu alt.' }],
    })
    expect(mail.subject).toBe('EasyBau: Bitte Betrieb prüfen (Muster Bau GmbH)')
    expect(mail.text).toContain('- Sicherung zu alt.')
    expect(mail.text).toContain('Einstellungen › Betrieb')
    const ok = alertMail('resolved', {
      appName: 'EasyBau',
      company: 'Muster Bau GmbH',
      problems: [],
    })
    expect(ok.subject).toBe('EasyBau: Betrieb wieder in Ordnung (Muster Bau GmbH)')
    expect(ok.text).toContain('behoben')
  })
})
