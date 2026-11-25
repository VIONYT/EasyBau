import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

/**
 * Dialog (DESIGN.md §7.2): a modal on the native <dialog> element – focus trap, Escape and the
 * backdrop come from the browser. On phones it opens as a bottom sheet (CSS).
 */
export function Dialog({
  open,
  title,
  onClose,
  closeLabel,
  children,
  footer,
}: {
  open: boolean
  title: string
  onClose: () => void
  /** Accessible name of the close button (from i18n). */
  closeLabel: string
  children: ReactNode
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal?.()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only closes on the backdrop; the keyboard closes with Escape (native cancel event) or the close button.
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        // Click on the backdrop (outside the content) closes.
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="dialog__content">
        <header className="dialog__head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="button ghost icon"
            aria-label={closeLabel}
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer ? <footer className="dialog__foot">{footer}</footer> : null}
      </div>
    </dialog>
  )
}

export type ToastTone = 'info' | 'success' | 'error'
interface ToastItem {
  id: number
  text: string
  tone: ToastTone
}

const ToastContext = createContext<(text: string, tone?: ToastTone) => void>(() => undefined)

/** Short confirmations („Gespeichert“) in a live region; they disappear after a few seconds. */
export function ToastProvider({
  children,
  duration = 4000,
}: {
  children: ReactNode
  duration?: number
}) {
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(0)
  const show = useCallback(
    (text: string, tone: ToastTone = 'success') => {
      const id = ++next.current
      setItems((list) => [...list.slice(-2), { id, text, tone }])
      setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), duration)
    },
    [duration],
  )
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((t) => (
          <p key={t.id} className={`toast toast--${t.tone}`}>
            {t.text}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
