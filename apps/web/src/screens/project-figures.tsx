import type { ProjectFiguresDto } from '@opc/schemas'
import { useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatCents, formatInputNumber } from '../format'
import { FormError } from '../forms'
import { t, tf } from '../i18n'

/**
 * Projektkennzahlen (P2.7): Soll-Stunden, Auftragssumme, abgerechnet, noch abzurechnen,
 * bezahlt und offene Forderungen. Only with the right to read documents (amounts).
 */
export function ProjectFiguresPanel({ projectId }: { projectId: string }) {
  const id = useId()
  const [figures, setFigures] = useState<ProjectFiguresDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<ProjectFiguresDto>('GET', `/api/v1/projects/${projectId}/figures`)
      .then(setFigures)
      .catch((err: ApiError) => setError(err.message))
  }, [projectId])
  if (error) return <FormError>{error}</FormError>
  if (!figures) return null
  const money = (cents: number | null) => (cents === null ? t('common.none') : formatCents(cents))
  return (
    <section className="panel figures" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('fig.title')}</h2>
      <div className="tiles">
        <div className="tile">
          <h3>{t('fig.plannedHours')}</h3>
          <p className="amount-big">
            {figures.hoursBasis
              ? `${formatInputNumber(figures.plannedHours)} ${t('d.hours')}`
              : t('common.none')}
          </p>
          <p className="hint">
            {figures.hoursBasis
              ? tf(figures.hoursBasis.kind === 'contract' ? 'fig.fromContract' : 'fig.fromQuote', {
                  label: figures.hoursBasis.label,
                })
              : t('fig.noBasis')}
            {figures.uncalculatedCount
              ? ` ${tf('fig.uncalculated', { count: String(figures.uncalculatedCount) })}`
              : ''}
          </p>
        </div>
        <div className="tile">
          <h3>{t('fig.contract')}</h3>
          <p className="amount-big">{money(figures.contractNetCents)}</p>
          <p className="hint">{t('fig.net')}</p>
        </div>
        <div className="tile">
          <h3>{t('fig.billed')}</h3>
          <p className="amount-big">{formatCents(figures.billedNetCents)}</p>
          <p className="hint">
            {[
              figures.billedPercent
                ? tf('fig.percent', { percent: formatInputNumber(figures.billedPercent) })
                : '',
              tf('fig.invoices', { count: String(figures.invoiceCount) }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="tile">
          <h3>{t('fig.unbilled')}</h3>
          <p className="amount-big">{money(figures.unbilledNetCents)}</p>
          {figures.overbilledNetCents ? (
            <p className="warning">
              {tf('fig.overbilled', { amount: formatCents(figures.overbilledNetCents) })}
            </p>
          ) : (
            <p className="hint">{t('fig.net')}</p>
          )}
        </div>
        <div className="tile">
          <h3>{t('fig.paid')}</h3>
          <p className="amount-big">{formatCents(figures.paidCents)}</p>
          <p className="hint">{t('fig.gross')}</p>
        </div>
        <div className="tile">
          <h3>{t('fig.open')}</h3>
          <p className="amount-big">{formatCents(figures.openReceivableCents)}</p>
          <p className="hint">{t('fig.gross')}</p>
        </div>
      </div>
    </section>
  )
}
