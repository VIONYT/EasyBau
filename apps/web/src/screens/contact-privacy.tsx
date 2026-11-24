import type { ContactDetail, ContactPrivacy, EraseContactResult } from '@opc/schemas'
import { Button, FormError, Notice } from '@opc/ui'
import { useState } from 'react'
import { type ApiError, api, downloadFile } from '../api'
import { formatDateTime } from '../format'
import { t, tf } from '../i18n'

/**
 * Datenschutz (DSGVO): Auskunft as a file (Art. 15/20), Löschen – at once, or blocked until the
 * end of the retention period of the invoices that name the contact (Art. 17/18).
 */
export function ContactPrivacyPanel({
  contact,
  onChanged,
}: {
  contact: ContactDetail
  onChanged: () => void
}) {
  const [plan, setPlan] = useState<ContactPrivacy | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const report = async () => {
    setError(null)
    try {
      await downloadFile(`/api/v1/contacts/${contact.id}/privacy-report`)
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  const prepare = async () => {
    setError(null)
    setDone(null)
    try {
      setPlan(await api<ContactPrivacy>('GET', `/api/v1/contacts/${contact.id}/privacy`))
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  const erase = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api<EraseContactResult>('POST', `/api/v1/contacts/${contact.id}/erase`, {
        confirm: true,
      })
      setPlan(null)
      setDone(
        result.result === 'erased'
          ? t('privacy.erasedNow')
          : tf('privacy.blockedNow', { date: formatDateTime(result.blockedUntil, 'date') }),
      )
      onChanged()
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="privacy-panel">
      <h3>{t('privacy.title')}</h3>
      {contact.erasedAt ? (
        <Notice>{tf('privacy.erased', { date: formatDateTime(contact.erasedAt, 'date') })}</Notice>
      ) : contact.blockedUntil ? (
        <Notice tone="warning">
          {tf('privacy.blocked', { date: formatDateTime(contact.blockedUntil, 'date') })}
        </Notice>
      ) : (
        <p className="hint">{t('privacy.hint')}</p>
      )}
      {done ? <Notice tone="success">{done}</Notice> : null}
      {plan ? (
        <div className="privacy-confirm" role="alertdialog" aria-label={t('privacy.erase')}>
          <p>
            {plan.action === 'erase'
              ? t('privacy.confirmErase')
              : tf('privacy.confirmBlock', {
                  n: String(plan.usage.finalizedDocuments + plan.usage.incomingInvoices),
                  date: formatDateTime(plan.retentionEnd, 'date'),
                })}
          </p>
          <div className="button-row">
            <Button variant="destructive" disabled={busy} onClick={erase}>
              {plan.action === 'erase' ? t('privacy.doErase') : t('privacy.doBlock')}
            </Button>
            <Button onClick={() => setPlan(null)}>{t('common.cancel')}</Button>
          </div>
        </div>
      ) : null}
      <FormError>{error}</FormError>
      <div className="button-row">
        <Button onClick={report}>{t('privacy.report')}</Button>
        {!contact.erasedAt && !contact.blockedUntil && !plan ? (
          <Button onClick={prepare}>{t('privacy.erase')}</Button>
        ) : null}
      </div>
    </div>
  )
}
