import type { Tx } from '@easybau/db'
import type { EvidenceItem, EvidenceRef } from '@easybau/schemas'
import { HttpError } from '../http.js'

/** Nachweise of a Nachtrag (Berichte, Aufmaßblätter, Dateien), used by documents and change orders. */

const invalid = (errors: Record<string, string>) =>
  new HttpError(400, 'Die Eingaben sind unvollständig oder ungültig.', errors)

interface EvidenceRow {
  kind: EvidenceRef['kind']
  id: string
  projectId: string
  label: string
  date: string | null
  locked: boolean
}

async function evidenceRows(tx: Tx, refs: readonly EvidenceRef[]): Promise<EvidenceRow[]> {
  const ids = (kind: EvidenceRef['kind']) => refs.filter((r) => r.kind === kind).map((r) => r.id)
  if (!refs.length) return []
  return tx<EvidenceRow[]>`
    select 'report' as kind, r.id, r.project_id as "projectId",
           t.name || ' vom ' || to_char(r.report_date, 'DD.MM.YYYY') as label,
           to_char(r.report_date, 'YYYY-MM-DD') as date, r.status = 'signed' as locked
    from report r join report_template t on t.id = r.template_id
    where r.id = any(${ids('report')}::uuid[])
    union all
    select 'measurement_sheet', s.id, s.project_id, 'Aufmaßblatt „' || s.title || '“',
           to_char(s.measured_on, 'YYYY-MM-DD'), s.status = 'signed'
    from measurement_sheet s where s.id = any(${ids('measurement_sheet')}::uuid[])
    union all
    select 'file', f.id, f.project_id, f.filename,
           to_char(f.created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD'), f.is_evidence
    from file f where f.id = any(${ids('file')}::uuid[])`
}

/** Nachweise must belong to the project of the change order; duplicates are dropped. */
export async function checkEvidence(
  tx: Tx,
  projectId: string,
  refs: readonly EvidenceRef[],
): Promise<EvidenceRef[]> {
  const unique = refs.filter(
    (ref, index) => refs.findIndex((r) => r.kind === ref.kind && r.id === ref.id) === index,
  )
  const rows = await evidenceRows(tx, unique)
  const errors: Record<string, string> = {}
  unique.forEach((ref, index) => {
    const row = rows.find((r) => r.kind === ref.kind && r.id === ref.id)
    if (!row || row.projectId !== projectId) {
      errors[`evidence.${index}`] = 'Dieser Nachweis gehört nicht zu diesem Projekt.'
    }
  })
  if (Object.keys(errors).length) throw invalid(errors)
  return unique.map(({ kind, id }) => ({ kind, id }))
}

/** Nachweise with label, date and lock state, in the stored order. */
export async function resolveEvidence(
  tx: Tx,
  refs: readonly EvidenceRef[],
): Promise<EvidenceItem[]> {
  const rows = await evidenceRows(tx, refs)
  return refs.flatMap((ref) => {
    const row = rows.find((r) => r.kind === ref.kind && r.id === ref.id)
    return row
      ? [{ kind: row.kind, id: row.id, label: row.label, date: row.date, locked: row.locked }]
      : []
  })
}
