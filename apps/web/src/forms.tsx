import { type FormEvent, useState } from 'react'
import { ApiError } from './api'

/** Form state: submitting flag, general error and field errors mapped from API problem details. */
export function useForm<T>(submit: (data: FormData) => Promise<T>, onSuccess: (result: T) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      onSuccess(await submit(new FormData(event.currentTarget)))
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setFieldErrors(err.fieldErrors)
      } else {
        setError(String(err))
      }
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, fieldErrors, onSubmit }
}

export const value = (data: FormData, name: string): string => String(data.get(name) ?? '').trim()
export const optional = (data: FormData, name: string): string | undefined =>
  value(data, name) || undefined

// Base components live in @easybau/ui (DESIGN.md §7.2); re-exported for the existing screens.
export { Field, FormError, SelectField, TextArea } from '@easybau/ui'
