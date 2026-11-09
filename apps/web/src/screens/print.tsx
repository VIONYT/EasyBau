import type { DocumentDetail } from '@opc/schemas'
import { useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatCents, formatDateTime, formatQuantity } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import type { Navigate } from '../router'
import { documentLabel } from './documents'

const COUNTED = new Set(['item', 'lump_sum'])

/**
 * Letter view of a document for printing or „Als PDF speichern“ in the browser.
 * The archived PDF/A (Typst) for invoices follows with finalizing invoices (DESIGN.md §4.1).
 */
export function PrintScreen({ id, navigate }: { id: string; navigate: Navigate }) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<DocumentDetail>('GET', `/api/v1/documents/${id}`)
      .then((d) => {
        setDoc(d)
        document.title = `${documentLabel(d)} ${d.number ?? ''}`.trim()
      })
      .catch((err: ApiError) => setError(err.message))
  }, [id])

  if (error) return <FormError>{error}</FormError>
  if (!doc) return <p className="muted">{t('common.loading')}</p>

  const label = documentLabel(doc)
  return (
    <div className="print-page">
      <div className="no-print button-row print-tools">
        <a
          className="button ghost"
          href={`/dokumente/${doc.id}`}
          onClick={(e) => {
            e.preventDefault()
            navigate({ view: 'document', id: doc.id })
          }}
        >
          ← {t('print.back')}
        </a>
        <button type="button" className="button primary auto" onClick={() => window.print()}>
          {t('print.print')}
        </button>
      </div>

      <article className={`letter${doc.status === 'draft' ? ' draft' : ''}`} aria-label={label}>
        {doc.status === 'draft' || doc.status === 'cancelled' ? (
          <div className="watermark" aria-hidden="true">
            {doc.status === 'draft' ? t('print.draft') : t('print.cancelled')}
          </div>
        ) : null}
        <header className="letter-head">
          <div className="letter-issuer">
            <strong>{doc.issuer.name}</strong>
            {doc.issuer.lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        </header>

        <div className="letter-address-row">
          <div className="letter-recipient">
            <small className="sender-line">
              {[doc.issuer.name, ...doc.issuer.lines].join(' · ')}
            </small>
            {doc.recipient ? (
              <>
                <span>{doc.recipient.name}</span>
                {doc.recipient.lines.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </>
            ) : null}
          </div>
          <dl className="letter-meta">
            <dt>{t('print.number')}</dt>
            <dd>{doc.number ?? t('print.draft')}</dd>
            <dt>{t('print.date')}</dt>
            <dd>{formatDateTime(doc.documentDate, 'date')}</dd>
            {doc.validUntil ? (
              <>
                <dt>{t('print.validUntil')}</dt>
                <dd>{formatDateTime(doc.validUntil, 'date')}</dd>
              </>
            ) : null}
            <dt>{t('print.project')}</dt>
            <dd>{[doc.project.number, doc.project.name].filter(Boolean).join(' · ')}</dd>
          </dl>
        </div>

        <h1 className="letter-title">
          {label}
          {doc.number ? ` ${doc.number}` : ''}
        </h1>
        {doc.subject ? <p className="letter-subject">{doc.subject}</p> : null}
        {doc.placeOfPerformance ? (
          <p className="letter-small">
            {t('print.place')}: {doc.placeOfPerformance}
          </p>
        ) : null}
        {doc.changeOrderInfo ? (
          <p className="letter-small">
            {t('q.changeOrderInfo')} {doc.changeOrderInfo.contractLabel}
            {doc.changeOrderInfo.reason ? ` – ${doc.changeOrderInfo.reason}` : ''}
          </p>
        ) : null}
        {doc.introText ? <p className="pre">{doc.introText}</p> : null}

        <table className="letter-items">
          <thead>
            <tr>
              <th scope="col">{t('print.pos')}</th>
              <th scope="col">{t('print.text')}</th>
              <th scope="col" className="num">
                {t('print.quantity')}
              </th>
              <th scope="col" className="num">
                {t('print.unitPrice')}
              </th>
              <th scope="col" className="num">
                {t('print.total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((item) =>
              item.positionType === 'title' ? (
                <tr key={item.id} className="title-row">
                  <td>{item.oz}</td>
                  <td colSpan={3}>
                    <strong>{item.shortText}</strong>
                  </td>
                  <td className="num">
                    <strong>{formatCents(doc.totals.titleSubtotals[item.id] ?? 0)}</strong>
                  </td>
                </tr>
              ) : item.positionType === 'text' ? (
                <tr key={item.id}>
                  <td />
                  <td colSpan={4} className="pre">
                    {item.longText ?? item.shortText}
                  </td>
                </tr>
              ) : (
                <tr key={item.id}>
                  <td>{item.oz}</td>
                  <td>
                    {item.shortText}
                    {item.positionType === 'optional' || item.positionType === 'alternative' ? (
                      <em>
                        {' '}
                        ({t(`doc.pos.${item.positionType}` as TextKey)} – {t('doc.notCounted')})
                      </em>
                    ) : null}
                    {item.longText ? (
                      <span className="pre block letter-small">{item.longText}</span>
                    ) : null}
                  </td>
                  <td className="num">
                    {formatQuantity(item.quantity, item.unit?.decimals)} {item.unit?.symbol}
                  </td>
                  <td className="num">{formatCents(item.unitPriceCents)}</td>
                  <td className="num">
                    {COUNTED.has(item.positionType)
                      ? formatCents(item.totalCents)
                      : `(${formatCents(item.totalCents)})`}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>

        <dl className="letter-totals">
          <div>
            <dt>{t('doc.net')}</dt>
            <dd>{formatCents(doc.totals.itemsNetCents)}</dd>
          </div>
          {doc.totals.discountCents ? (
            <div>
              <dt>
                {t('doc.discountLine')} {formatQuantity(doc.discountPercent)} %
              </dt>
              <dd>− {formatCents(doc.totals.discountCents)}</dd>
            </div>
          ) : null}
          {doc.totals.taxLines.map((line) => (
            <div key={`${line.category}-${line.ratePercent}`}>
              <dt>
                {t('doc.vat')} {formatQuantity(line.ratePercent)} % ({formatCents(line.netCents)})
                {line.exemptionReason ? (
                  <span className="block letter-small">{line.exemptionReason}</span>
                ) : null}
              </dt>
              <dd>{formatCents(line.taxCents)}</dd>
            </div>
          ))}
          <div className="grand">
            <dt>{t('doc.gross')}</dt>
            <dd>{formatCents(doc.totals.grossCents)}</dd>
          </div>
        </dl>

        {doc.paymentDueDays !== null ? (
          <p>{tf('print.paymentDays', { days: String(doc.paymentDueDays) })}</p>
        ) : null}
        {doc.closingText ? <p className="pre">{doc.closingText}</p> : null}

        <footer className="letter-foot">
          <span>{[doc.issuer.name, ...doc.issuer.lines].join(' · ')}</span>
          {doc.issuer.contact.length ? <span>{doc.issuer.contact.join(' · ')}</span> : null}
          {doc.issuer.legal.length ? <span>{doc.issuer.legal.join(' · ')}</span> : null}
        </footer>
      </article>
    </div>
  )
}
