import { defaultLetterhead } from '@opc/domain'
import type { DocumentDetail } from '@opc/schemas'
import { useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatCents, formatDateTime, formatQuantity } from '../format'
import { FormError } from '../forms'
import { type TextKey, t, tf } from '../i18n'
import { type InfoRow, LetterPage, ScaledPage } from '../letter'
import type { Navigate } from '../router'
import { DeductionTable } from './document'
import { documentLabel } from './documents'

const COUNTED = new Set(['item', 'lump_sum'])

/** Informationsblock (DIN 5008): number, dates, project. */
function infoRows(doc: DocumentDetail): InfoRow[] {
  const rows: InfoRow[] = [
    { label: t('print.number'), value: doc.number ?? t('print.draft') },
    { label: t('print.date'), value: formatDateTime(doc.documentDate, 'date') },
  ]
  if (doc.validUntil) {
    rows.push({ label: t('print.validUntil'), value: formatDateTime(doc.validUntil, 'date') })
  }
  if (doc.serviceFrom || doc.serviceTo) {
    rows.push({
      label: t('print.service'),
      value: [doc.serviceFrom, doc.serviceTo]
        .filter((d, i, all): d is string => !!d && all.indexOf(d) === i)
        .map((d) => formatDateTime(d, 'date'))
        .join(' – '),
    })
  }
  if (doc.dueDate) rows.push({ label: t('print.due'), value: formatDateTime(doc.dueDate, 'date') })
  rows.push({
    label: t('print.project'),
    value: [doc.project.number, doc.project.name].filter(Boolean).join(' · '),
  })
  return rows
}

/** Documents finalized before the letterhead existed: company data from the old snapshot. */
function fallbackValues(doc: DocumentDetail) {
  const [street, place] = doc.issuer.lines
  return { Firma: doc.issuer.name, Straße: street ?? null, Ort: place ?? null }
}

/**
 * Letter view of a document (DIN 5008 Form B, A4). The PDF/A-3 is rendered with Typst on the
 * server; finalized documents return their archived original.
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
        <a
          className="button primary auto"
          href={`/api/v1/documents/${doc.id}/pdf`}
          target="_blank"
          rel="noopener"
        >
          {t('print.pdf')}
        </a>
        <button type="button" className="button ghost" onClick={() => window.print()}>
          {t('print.print')}
        </button>
      </div>

      <ScaledPage>
        <LetterPage
          layout={doc.issuer.letterhead ?? defaultLetterhead()}
          values={doc.issuer.values ?? fallbackValues(doc)}
          recipient={doc.recipient ? [doc.recipient.name, ...doc.recipient.lines] : []}
          info={infoRows(doc)}
          watermark={
            doc.status === 'draft'
              ? t('print.draft')
              : doc.status === 'cancelled'
                ? t('print.cancelled')
                : null
          }
        >
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

          {doc.totals.deductions.length ? <DeductionTable doc={doc} /> : null}
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
              <dt>{doc.totals.deductions.length ? t('inv.restGross') : t('doc.gross')}</dt>
              <dd>{formatCents(doc.totals.grossCents)}</dd>
            </div>
            {doc.totals.retentionCents ? (
              <div>
                <dt>
                  {t('inv.retention')} {formatQuantity(doc.retentionPercent)} %
                </dt>
                <dd>− {formatCents(doc.totals.retentionCents)}</dd>
              </div>
            ) : null}
            {doc.totals.constructionLevyCents ? (
              <div>
                <dt>
                  {t('inv.levy')} {formatQuantity(doc.constructionLevyPercent)} %
                </dt>
                <dd>− {formatCents(doc.totals.constructionLevyCents)}</dd>
              </div>
            ) : null}
            {doc.totals.retentionCents || doc.totals.constructionLevyCents ? (
              <div className="grand">
                <dt>{t('inv.payable')}</dt>
                <dd>{formatCents(doc.totals.payableCents)}</dd>
              </div>
            ) : null}
          </dl>

          {doc.legalNotes.length ? (
            doc.legalNotes.map((note) => <p key={note}>{note}</p>)
          ) : doc.paymentDueDays !== null ? (
            <p>{tf('print.paymentDays', { days: String(doc.paymentDueDays) })}</p>
          ) : null}
          {doc.closingText ? <p className="pre">{doc.closingText}</p> : null}
        </LetterPage>
      </ScaledPage>
    </div>
  )
}
