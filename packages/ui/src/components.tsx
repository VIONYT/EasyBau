import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'

/**
 * Button (DESIGN.md §7.2): primary for the one main action of a screen, secondary/ghost for the
 * rest, destructive for deleting. `site` makes the 56 px touch target of the site screens;
 * `full` spans the width (default for primary on phones), `width="natural"` leaves the width to
 * the context (e.g. a primary button filling a narrow form). `size` makes compact buttons in
 * lists (`small`) or square icon buttons (`icon`, still ≥ 44 px); `danger` colours a ghost
 * button red (e.g. „Entfernen“ in a row).
 */
export interface ButtonStyle {
  variant?: ButtonVariant | undefined
  site?: boolean | undefined
  full?: boolean | undefined
  width?: 'auto' | 'full' | 'natural' | undefined
  size?: 'small' | 'icon' | undefined
  danger?: boolean | undefined
  className?: string | undefined
}

/**
 * Class names of a button, for elements that must stay links or labels but look like a button
 * (download links, file pickers) – the same look as <Button>.
 */
export function buttonClass({
  variant = 'secondary',
  site = false,
  full = false,
  width = 'auto',
  size,
  danger = false,
  className,
}: ButtonStyle = {}): string {
  const span = full ? 'full' : width === 'natural' ? null : width
  return [
    'button',
    variant === 'primary' ? 'primary' : variant === 'destructive' ? 'danger' : 'ghost',
    variant === 'secondary' ? 'secondary' : null,
    span,
    size ?? null,
    danger && variant !== 'destructive' ? 'danger' : null,
    site ? 'site' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ')
}

export function Button({
  variant,
  site,
  full,
  width,
  size,
  danger,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & ButtonStyle) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, site, full, width, size, danger, className })}
      {...props}
    />
  )
}

export type Tone = 'info' | 'success' | 'warning' | 'error'

/** A message in the flow of the page; errors and successes are announced to screen readers. */
export function Notice({ tone = 'info', children }: { tone?: Tone; children?: ReactNode }) {
  const role = tone === 'error' ? 'alert' : tone === 'success' ? 'status' : undefined
  return (
    <p className={`notice notice--${tone}`} role={role}>
      {children}
    </p>
  )
}

/** Status badge, e.g. „Festgeschrieben“, „Überfällig“. */
export function Badge({
  tone = 'info',
  children,
}: {
  tone?: Tone | 'neutral'
  children?: ReactNode
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

/** „1.234,56 €“ from cents, with tabular figures; display only (calculation on the server). */
export function formatEuro(cents: number): string {
  return euro.format(cents / 100)
}

export function Amount({ cents, strong = false }: { cents: number | null; strong?: boolean }) {
  if (cents === null) return null
  const text = formatEuro(cents)
  return <span className={strong ? 'amount amount--strong' : 'amount'}>{text}</span>
}
