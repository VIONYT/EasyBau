import type { ContactDetail, ContactSummary, MergeContactResult, Page } from '@easybau/schemas'
import { Button, FormError, Notice, SelectField } from '@easybau/ui'
import { useEffect, useState } from 'react'
import { type ApiError, api } from '../api'
import { t, tf } from '../i18n'

/**
 * Kontakte zusammenführen: this contact (the duplicate) goes into the chosen one. Projects,
 * drafts, contact persons, missing channels and addresses move over; finalised documents stay.
 */
export function ContactMergePanel({
  contact,
  onMerged,
}: {
  contact: ContactDetail
  onMerged: (into: ContactDetail) => void
}) {
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<ContactSummary[]>([])
  const [intoId, setIntoId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    api<Page<ContactSummary>>('GET', `/api/v1/contacts?limit=100&kind=${contact.kind}`)
      .then((page) => setCandidates(page.items.filter((c) => c.id !== contact.id)))
      .catch((err: ApiError) => setError(err.message))
  }, [open, contact.id, contact.kind])

  if (contact.mergedInto) {
    return <Notice>{tf('merge.done', { name: contact.mergedInto.displayName })}</Notice>
  }
  if (contact.blockedUntil || contact.erasedAt) return null
  const target = candidates.find((c) => c.id === intoId)
  const merge = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api<MergeContactResult>('POST', `/api/v1/contacts/${contact.id}/merge`, {
        intoId,
        confirm: true,
      })
      onMerged(result.into)
    } catch (err) {
      setError((err as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="merge-panel">
      <h3>{t('merge.title')}</h3>
      {open ? (
        <>
          <p className="hint">{t('merge.hint')}</p>
          <SelectField
            label={t('merge.into')}
            name="intoId"
            value={intoId}
            onChange={setIntoId}
            options={[
              { value: '', label: t('common.none') },
              ...candidates.map((c) => ({
                value: c.id,
                label: [c.displayName, c.number, c.city].filter(Boolean).join(' · '),
              })),
            ]}
          />
          {target ? (
            <p role="alert">
              {tf('merge.confirm', { from: contact.displayName, into: target.displayName })}
            </p>
          ) : null}
          <FormError>{error}</FormError>
          <div className="button-row">
            <Button variant="destructive" disabled={!target || busy} onClick={merge}>
              {t('merge.submit')}
            </Button>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          </div>
        </>
      ) : (
        <Button onClick={() => setOpen(true)}>{t('merge.open')}</Button>
      )}
    </div>
  )
}
