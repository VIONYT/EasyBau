import { useId } from 'react'
import { parseEuro } from './money.js'

interface AffixFieldProps {
  label: string
  name: string
  /** Shown after the value inside the field, e.g. „€“ or „m²“. */
  suffix: string
  defaultValue?: string | undefined
  hint?: string | undefined
  error?: string | undefined
  required?: boolean
  inputMode?: 'decimal' | 'numeric' | 'text'
  onBlur?: (value: string, input: HTMLInputElement) => void
  /** Controlled use (e.g. a suggested amount the screen updates); otherwise `defaultValue`. */
  value?: string | undefined
  onChange?: ((value: string) => void) | undefined
  /** Marks the field invalid while typing (controlled use). */
  invalid?: boolean | undefined
}

/** Input with a unit after the value (Input mit Einheit, DESIGN.md §7.2). */
export function UnitField({
  label,
  name,
  suffix,
  defaultValue,
  hint,
  error,
  required,
  inputMode = 'decimal',
  onBlur,
  value,
  onChange,
  invalid,
}: AffixFieldProps) {
  const id = useId()
  const describedBy =
    [hint ? `${id}-hint` : '', error ? `${id}-error` : '', `${id}-suffix`]
      .filter(Boolean)
      .join(' ') || undefined
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <div className="input-affix">
        <input
          id={id}
          name={name}
          inputMode={inputMode}
          autoComplete="off"
          required={required}
          {...(value !== undefined
            ? { value, onChange: (e) => onChange?.(e.currentTarget.value) }
            : { defaultValue })}
          aria-invalid={error || invalid ? true : undefined}
          aria-describedby={describedBy}
          onBlur={onBlur ? (e) => onBlur(e.currentTarget.value, e.currentTarget) : undefined}
        />
        <span id={`${id}-suffix`} className="input-affix__suffix">
          {suffix}
        </span>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Geldfeld: amount in euros with German notation („1.234,56 €“), right-aligned with tabular
 * figures. Read the value with `parseEuro()` (cents as bigint); invalid input shows `invalidText`.
 */
export function MoneyField({
  invalidText,
  error,
  ...props
}: Omit<AffixFieldProps, 'suffix' | 'inputMode'> & { invalidText: string }) {
  return (
    <UnitField
      {...props}
      suffix="€"
      inputMode="decimal"
      error={error}
      onBlur={(value, input) => {
        props.onBlur?.(value, input)
        // Native validity: the browser and screen readers report the problem on submit.
        input.setCustomValidity(parseEuro(value) === undefined ? invalidText : '')
      }}
    />
  )
}
