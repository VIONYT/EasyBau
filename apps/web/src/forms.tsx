import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { ApiError } from './api'

interface FieldProps {
  label: string
  name: string
  type?: 'text' | 'email' | 'password'
  autoComplete?: string
  hint?: string | undefined
  required?: boolean
  error?: string | undefined
  inputMode?: 'text' | 'numeric'
  defaultValue?: string
}

/** Labelled input with hint and error, accessible (WCAG 2.2 AA) and large enough for touch. */
export function Field({
  label,
  name,
  type = 'text',
  autoComplete,
  hint,
  required,
  error,
  inputMode,
  defaultValue,
}: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy =
    [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        inputMode={inputMode}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}

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

export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <p className="form-error" role="alert">
      {children}
    </p>
  )
}

export const value = (data: FormData, name: string): string => String(data.get(name) ?? '').trim()
export const optional = (data: FormData, name: string): string | undefined =>
  value(data, name) || undefined
