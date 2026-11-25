import type { ProjectContract } from '@easybau/schemas'
import { useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatCents, formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t } from '../i18n'
import type { Navigate } from '../router'

/**
 * Vertragssumme (P2.6): Hauptauftrag + beauftragte Nachträge, with the open (offered, draft) and
 * rejected change orders listed separately.
 */
export function ContractPanel({ projectId, navigate }: { projectId: string; navigate: Navigate }) {
  const id = useId()
  const [data, setData] = useState<ProjectContract | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<ProjectContract>('GET', `/api/v1/projects/${projectId}/contract`)
      .then(setData)
      .catch((err: ApiError) => setError(err.message))
  }, [projectId])
  if (error) return <FormError>{error}</FormError>
  if (!data || (!data.contract && !data.changeOrders.length)) return null
  const open = (docId: string) => navigate({ view: 'document', id: docId })
  const { totals } = data
  return (
    <section className="panel contract" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('contract.title')}</h2>
      <dl className="facts">
        <dt>{t('contract.main')}</dt>
        <dd>
          {data.contract ? (
            <a
              href={`/dokumente/${data.contract.id}`}
              onClick={(e) => {
                e.preventDefault()
                if (data.contract) open(data.contract.id)
              }}
            >
              {data.contract.number ?? t('contract.draft')}
            </a>
          ) : (
            t('common.none')
          )}{' '}
          <span className="amount">{formatCents(totals.contractNetCents)}</span>
        </dd>
        <dt>{t('contract.accepted')}</dt>
        <dd className="amount">{formatCents(totals.acceptedNetCents)}</dd>
        <dt>
          <strong>{t('contract.total')}</strong>
        </dt>
        <dd className="amount">
          <strong>{formatCents(totals.totalNetCents)}</strong>
        </dd>
        {totals.offeredNetCents ? (
          <>
            <dt>{t('contract.offered')}</dt>
            <dd className="amount">{formatCents(totals.offeredNetCents)}</dd>
            <dt>{t('contract.potential')}</dt>
            <dd className="amount">{formatCents(totals.potentialNetCents)}</dd>
          </>
        ) : null}
      </dl>
      <p className="hint">{t('contract.netHint')}</p>
      {data.changeOrders.length ? (
        <>
          <h3>{t('contract.changeOrders')}</h3>
          <ul className="list">
            {data.changeOrders.map((o) => (
              <li key={o.id} className="list-link">
                <a
                  href={`/dokumente/${o.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    open(o.id)
                  }}
                >
                  <span className="doc-line">
                    <strong>
                      N{String(o.changeOrderNumber).padStart(2, '0')}
                      {o.subject ? ` · ${o.subject}` : ''}
                    </strong>
                    <span className={`chip chip--${o.status}`}>
                      {t(`contract.status.${o.status}` as TextKey)}
                    </span>
                    <span className="amount">{formatCents(o.netCents)}</span>
                  </span>
                  <span className="muted">
                    {[
                      t(`doc.basis.${o.basis}` as TextKey),
                      o.reason,
                      o.evidenceCount
                        ? `${o.evidenceCount} ${t(o.evidenceCount === 1 ? 'ev.one' : 'ev.many')}`
                        : t('ev.none'),
                      o.decidedAt
                        ? `${t('contract.decided')} ${formatDateTime(o.decidedAt, 'date')}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
