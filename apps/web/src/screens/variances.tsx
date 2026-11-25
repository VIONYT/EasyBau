import type { DocumentDetail, MeasurementSheetDetail, SheetVariance } from '@easybau/schemas'
import { useEffect, useId, useState } from 'react'
import { type ApiError, api } from '../api'
import { formatInputNumber } from '../format'
import { FormError } from '../forms'
import { t, tf } from '../i18n'
import type { Navigate } from '../router'

const amount = (value: string, unit: string | null) =>
  `${formatInputNumber(value)}${unit ? ` ${unit}` : ''}`

/**
 * Mehrmengen (P2.6): contract positions of this Leistungsaufmaß measured beyond the ordered
 * quantity; one click creates a Nachtrag (VOB/B § 2 Abs. 3) with the sheet as Nachweis.
 */
export function VariancePanel({
  sheet,
  lineCount,
  navigate,
}: {
  sheet: MeasurementSheetDetail
  lineCount: number
  navigate: Navigate
}) {
  const id = useId()
  const [variances, setVariances] = useState<SheetVariance[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (lineCount < 0) return
    api<SheetVariance[]>('GET', `/api/v1/measurement-sheets/${sheet.id}/variances`)
      .then(setVariances)
      .catch((err: ApiError) => setError(err.message))
  }, [sheet.id, lineCount])
  if (!variances) return error ? <FormError>{error}</FormError> : null
  const extras = variances.filter((v) => Number(v.extraQuantity) > 0)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const doc = await api<DocumentDetail>(
        'POST',
        `/api/v1/measurement-sheets/${sheet.id}/change-order`,
        {},
      )
      navigate({ view: 'document', id: doc.id })
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t('var.title')}</h2>
      <p className="hint">{t('var.hint')}</p>
      {variances.length ? (
        <ul className="list plain">
          {variances.map((v) => (
            <li key={v.itemId}>
              <strong>
                {v.oz ? `${v.oz} ` : ''}
                {v.shortText}
              </strong>
              <span className="muted block">
                {tf(Number(v.extraQuantity) > 0 ? 'var.line' : 'var.lineLess', {
                  ordered: amount(v.orderedQuantity, v.unit),
                  measured: amount(v.measuredQuantity, v.unit),
                  extra: amount(v.extraQuantity, v.unit),
                })}
              </span>
              {v.deviation ? (
                <span className="hint block">
                  {tf(v.deviation === 'over_110' ? 'var.over110' : 'var.under90', {
                    percent: v.measuredPercent ?? '',
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('var.none')}</p>
      )}
      <FormError>{error}</FormError>
      {extras.length ? (
        <button type="button" className="button primary auto" disabled={busy} onClick={create}>
          {t('var.create')}
        </button>
      ) : null}
    </section>
  )
}
