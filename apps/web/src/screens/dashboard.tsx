import type { DashboardDto, DashboardSiteDto, DashboardSum, Me } from '@opc/schemas'
import { useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatCents, formatDateTime } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import type { Navigate } from '../router'
import { StatusBadge } from './projects'

const HIDE_KEY = 'opc.dashboard.hideAmounts'

/** Per-device preference only (no data): Beträge ausblenden, e.g. in front of customers. */
function useHideAmounts(): [boolean, (hide: boolean) => void] {
  const [hide, setHide] = useState(() => {
    try {
      return window.localStorage.getItem(HIDE_KEY) === '1'
    } catch {
      return false
    }
  })
  const set = (value: boolean) => {
    setHide(value)
    try {
      window.localStorage.setItem(HIDE_KEY, value ? '1' : '0')
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  }
  return [hide, set]
}

/** Übersicht (P2.8, DESIGN.md §7.3): Startseite nach der Anmeldung. */
export function Dashboard({ me, navigate }: { me: Me; navigate: Navigate }) {
  const id = useId()
  const [data, setData] = useState<DashboardDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [siteOnly, setSiteOnly] = useState(false)
  const [hide, setHide] = useHideAmounts()
  useEffect(() => {
    const site = () => api<DashboardSiteDto>('GET', '/api/v1/dashboard/site')
    api<DashboardDto>('GET', '/api/v1/dashboard')
      .then((full) => {
        setData(full)
        // Keep the part without amounts on the device for the start page without network.
        site().catch(() => undefined)
      })
      .catch(async (err: ApiError) => {
        try {
          const part = await site()
          setData({ ...part, receivables: null, incomingReviewCount: null, openOffers: null })
          setSiteOnly(true)
        } catch {
          setError(err.message)
        }
      })
  }, [])
  const money = (cents: number) => (hide ? '•••' : formatCents(cents))
  const link = (href: string, go: () => void, label: string) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        go()
      }}
    >
      {label}
    </a>
  )
  const sum = (key: 'open' | 'overdue' | 'dunned', s: DashboardSum) => (
    <div className={`receivable-sum receivable-sum--${key}`}>
      <span className="muted">{t(`dash.receivables.${key}` as TextKey)}</span>
      <strong className="amount">{money(s.cents)}</strong>
      <span className="muted">{tf('dash.count', { count: String(s.count) })}</span>
    </div>
  )

  return (
    <section aria-labelledby={`${id}-title`}>
      <div className="section-head">
        <h1 id={`${id}-title`}>{t('nav.dashboard')}</h1>
        {data?.receivables || data?.openOffers ? (
          <label className="check">
            <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
            <span>{t('dash.hideAmounts')}</span>
          </label>
        ) : null}
      </div>
      <div className="button-row">
        {me.permissions.includes('project.write') ? (
          <button
            type="button"
            className="button primary auto"
            onClick={() => navigate({ view: 'projects' })}
          >
            {t('dash.action.project')}
          </button>
        ) : null}
        {data?.todaysSites[0] && me.permissions.includes('report.write') ? (
          <button
            type="button"
            className="button ghost auto"
            onClick={() =>
              navigate({ view: 'project', id: data.todaysSites[0]?.id as string, section: 'diary' })
            }
          >
            {t('dash.action.report')}
          </button>
        ) : null}
      </div>
      <FormError>{error}</FormError>
      {siteOnly ? <p className="hint">{t('dash.siteOnly')}</p> : null}
      {!data && !error ? <p className="muted">{t('common.loading')}</p> : null}
      {data ? (
        <div className="dashboard">
          {data.receivables ? (
            <section className="panel" aria-labelledby={`${id}-rec`}>
              <h2 id={`${id}-rec`}>{t('dash.receivables')}</h2>
              <p className="amount-big">{money(data.receivables.total.cents)}</p>
              <div className="dashboard-sums">
                {sum('open', data.receivables.open)}
                {sum('overdue', data.receivables.overdue)}
                {sum('dunned', data.receivables.dunned)}
              </div>
              <p>
                {link('/rechnungen', () => navigate({ view: 'invoices' }), t('dash.toInvoices'))}
                {data.receivables.dunningDueCount
                  ? ` · ${tf('dash.dunningDue', { count: String(data.receivables.dunningDueCount) })}`
                  : ''}
              </p>
            </section>
          ) : null}
          {data.incomingReviewCount !== null ? (
            <section className="panel" aria-labelledby={`${id}-in`}>
              <h2 id={`${id}-in`}>{t('dash.incoming')}</h2>
              <p className="amount-big">{data.incomingReviewCount}</p>
              <p>
                {link(
                  '/eingangsrechnungen',
                  () => navigate({ view: 'incoming' }),
                  data.incomingReviewCount ? t('dash.incomingReview') : t('dash.incomingNone'),
                )}
              </p>
            </section>
          ) : null}
          <section className="panel" aria-labelledby={`${id}-today`}>
            <h2 id={`${id}-today`}>{t('dash.today')}</h2>
            {data.todaysSites.length ? (
              <ul className="list">
                {data.todaysSites.map((p) => (
                  <li key={p.id} className="list-link">
                    <a
                      href={`/projekte/${p.id}`}
                      onClick={(e) => {
                        e.preventDefault()
                        navigate({ view: 'project', id: p.id, section: 'overview' })
                      }}
                    >
                      <strong>
                        {p.number ? `${p.number} · ` : ''}
                        {p.name}
                      </strong>
                      <span className="muted">
                        {[
                          p.site,
                          p.endDate
                            ? tf('dash.until', { date: formatDateTime(p.endDate, 'date') })
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('dash.todayNone')}</p>
            )}
          </section>
          {data.openOffers ? (
            <section className="panel" aria-labelledby={`${id}-offers`}>
              <h2 id={`${id}-offers`}>{t('dash.offers')}</h2>
              {data.openOffers.length ? (
                <ul className="list">
                  {data.openOffers.map((o) => (
                    <li key={o.id} className="list-link">
                      <a
                        href={`/dokumente/${o.id}`}
                        onClick={(e) => {
                          e.preventDefault()
                          navigate({ view: 'document', id: o.id })
                        }}
                      >
                        <span className="doc-line">
                          <strong>
                            {t(`dash.type.${o.type}` as TextKey)} {o.number}
                          </strong>
                          <span className={`chip chip--${o.status}`}>
                            {t(`dash.status.${o.status}` as TextKey)}
                          </span>
                          <span className="amount">{money(o.netCents)}</span>
                        </span>
                        <span className="muted">
                          {[
                            o.project.name,
                            o.subject,
                            o.validUntil
                              ? tf('dash.validUntil', {
                                  date: formatDateTime(o.validUntil, 'date'),
                                })
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{t('dash.offersNone')}</p>
              )}
            </section>
          ) : null}
          <section className="panel" aria-labelledby={`${id}-recent`}>
            <h2 id={`${id}-recent`}>{t('dash.recent')}</h2>
            {data.recentProjects.length ? (
              <ul className="list">
                {data.recentProjects.map((p) => (
                  <li key={p.id} className="list-link">
                    <a
                      href={`/projekte/${p.id}`}
                      onClick={(e) => {
                        e.preventDefault()
                        navigate({ view: 'project', id: p.id, section: 'overview' })
                      }}
                    >
                      <strong>
                        {p.number ? `${p.number} · ` : ''}
                        {p.name}
                      </strong>
                      <span className="muted">
                        {[p.customer?.displayName, p.siteCity].filter(Boolean).join(' · ')}
                      </span>
                      {p.status ? <StatusBadge status={p.status} /> : null}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('common.empty')}</p>
            )}
          </section>
        </div>
      ) : null}
    </section>
  )
}
