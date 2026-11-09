import { clampToPage, DIN5008B, fillPlaceholders, type LetterheadValues } from '@opc/domain'
import type { LetterheadLayout } from '@opc/schemas'
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/** CSS pixels per millimetre (96 dpi). */
export const PX_PER_MM = 96 / 25.4

const mm = (value: number) => `${value}mm`

/**
 * Shows an A4 page at its real size, scaled down to the available width on small screens
 * (no horizontal scrolling at 375 px). Printing always uses the real size (see styles.css).
 */
export function ScaledPage({
  children,
  onScale,
}: {
  children: ReactNode
  onScale?: (scale: number) => void
}) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const update = () => {
      const width = outer.current?.clientWidth ?? 0
      const next = Math.min(1, width / (DIN5008B.page.width * PX_PER_MM))
      setScale(next)
      onScale?.(next)
      setHeight((inner.current?.offsetHeight ?? 0) * next)
    }
    update()
    const observer = new ResizeObserver(update)
    if (outer.current) observer.observe(outer.current)
    if (inner.current) observer.observe(inner.current)
    return () => observer.disconnect()
  }, [onScale])
  return (
    <div
      ref={outer}
      className="scaled-page"
      style={height ? { ['--scaled-height' as string]: `${height}px` } : undefined}
    >
      <div
        ref={inner}
        className="scaled-page__inner"
        style={{ ['--page-scale' as string]: String(scale) }}
      >
        {children}
      </div>
    </div>
  )
}

export interface InfoRow {
  label: string
  value: string
}

/** Editing support for the WYSIWYG editor (Briefkopf elements). */
export interface LetterEditing {
  selected: string | null
  select: (id: string | null) => void
  /** Move/resize an element; positions in mm. */
  update: (id: string, patch: { x?: number; y?: number; width?: number }) => void
  scale: number
  labels: { logo: string; text: string; resize: string }
}

/**
 * A letter page per DIN 5008 Form B: Briefkopf (logo, texts), Anschriftfeld with
 * Rücksendeangabe, Informationsblock, Falz- und Lochmarken, text and footer.
 */
export function LetterPage({
  layout,
  values,
  recipient,
  info,
  watermark,
  children,
  editing,
}: {
  layout: LetterheadLayout
  values: LetterheadValues
  recipient: string[]
  info: InfoRow[]
  watermark?: string | null
  children?: ReactNode
  editing?: LetterEditing | undefined
}) {
  const footer = layout.footer.map((column) => fillPlaceholders(column, values)).filter(Boolean)
  return (
    <div
      className={`letter-sheet font-${layout.font}${editing ? ' is-editing' : ''}`}
      style={{ ['--accent' as string]: layout.accentColor }}
    >
      {watermark ? (
        <div className="letter-watermark" aria-hidden="true">
          {watermark}
        </div>
      ) : null}
      {layout.foldMarks ? (
        <>
          <span className="fold-mark" style={{ top: mm(DIN5008B.marks.fold1) }} />
          <span className="fold-mark hole" style={{ top: mm(DIN5008B.marks.hole) }} />
          <span className="fold-mark" style={{ top: mm(DIN5008B.marks.fold2) }} />
        </>
      ) : null}

      {/* Briefkopf */}
      <div
        className="letter-header"
        style={{ height: mm(DIN5008B.header.height) }}
        onPointerDown={editing ? () => editing.select(null) : undefined}
      >
        {layout.logo ? (
          <Positioned
            id="logo"
            x={layout.logo.x}
            y={layout.logo.y}
            width={layout.logo.width}
            editing={editing}
            label={editing?.labels.logo ?? ''}
          >
            <img
              src={`/api/v1/assets/${layout.logo.assetId}`}
              alt=""
              className="letter-logo"
              // The logo stays inside the Briefkopf (Form B: 45 mm), proportions are kept.
              style={{ maxHeight: mm(Math.max(DIN5008B.header.height - layout.logo.y, 5)) }}
            />
          </Positioned>
        ) : null}
        {layout.texts.map((text) => (
          <Positioned
            key={text.id}
            id={text.id}
            x={text.x}
            y={text.y}
            width={text.width}
            editing={editing}
            label={`${editing?.labels.text ?? ''}: ${text.text.split('\n')[0]}`}
          >
            <div
              className="letter-text"
              style={{
                fontSize: `${text.fontSize}pt`,
                fontWeight: text.bold ? 700 : 400,
                textAlign: text.align,
                color: text.color,
              }}
            >
              {fillPlaceholders(text.text, values) || (editing ? text.text : '')}
            </div>
          </Positioned>
        ))}
      </div>

      {/* Anschriftfeld (Fensterumschlag) */}
      <div
        className="letter-address"
        style={{
          left: mm(DIN5008B.address.x + DIN5008B.address.inset),
          top: mm(DIN5008B.address.y),
          width: mm(DIN5008B.address.width - DIN5008B.address.inset),
          height: mm(DIN5008B.address.height),
        }}
      >
        <div className="letter-sender" style={{ height: mm(DIN5008B.address.noteZone) }}>
          <span>{fillPlaceholders(layout.senderLine, values)}</span>
        </div>
        <div className="letter-recipient">
          {recipient.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: address lines may repeat
            <span key={index}>{line}</span>
          ))}
        </div>
      </div>

      {/* Informationsblock */}
      <dl
        className="letter-info"
        style={{
          left: mm(DIN5008B.info.x),
          top: mm(DIN5008B.info.y),
          width: mm(DIN5008B.info.width),
        }}
      >
        {info.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {/* Text: thead/tfoot repeat on every printed page (top margin, room for the footer). */}
      {/* Spacer instead of a margin: printers drop margins at the top of a page. */}
      <div className="letter-flow__start" aria-hidden="true" />
      <table className="letter-flow">
        <thead>
          <tr>
            <td className="letter-flow__cell">
              <div className="letter-flow__top" />
            </td>
          </tr>
        </thead>
        <tfoot>
          <tr>
            <td className="letter-flow__cell">
              <div className="letter-flow__bottom" />
            </td>
          </tr>
        </tfoot>
        <tbody>
          <tr>
            <td className="letter-flow__cell letter-body">{children}</td>
          </tr>
        </tbody>
      </table>

      <footer className="letter-footer">
        {footer.map((column, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity
          <div key={index} className="letter-footer__column">
            {column}
          </div>
        ))}
      </footer>
    </div>
  )
}

const STEP_MM = 1

/** An element of the Briefkopf; draggable and resizable in the editor. */
function Positioned({
  id,
  x,
  y,
  width,
  editing,
  label,
  children,
}: {
  id: string
  x: number
  y: number
  width: number
  editing: LetterEditing | undefined
  label: string
  children: ReactNode
}) {
  const drag = useRef<{
    mode: 'move' | 'resize'
    startX: number
    startY: number
    x: number
    y: number
    width: number
  } | null>(null)
  const selected = editing?.selected === id
  const style = { left: mm(x), top: mm(y), width: mm(width) }
  if (!editing) {
    return (
      <div className="letter-positioned" style={style}>
        {children}
      </div>
    )
  }
  const toMm = (px: number) => px / (editing.scale * PX_PER_MM)
  const start = (mode: 'move' | 'resize') => (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation()
    event.preventDefault()
    editing.select(id)
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { mode, startX: event.clientX, startY: event.clientY, x, y, width }
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const dx = toMm(event.clientX - d.startX)
    const dy = toMm(event.clientY - d.startY)
    if (d.mode === 'move') {
      editing.update(id, clampToPage(d.x + dx, d.y + dy, d.width))
    } else {
      const max = DIN5008B.page.width - d.x
      editing.update(id, { width: Math.round(Math.min(Math.max(d.width + dx, 10), max) * 10) / 10 })
    }
  }
  const end = () => {
    drag.current = null
  }
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 5 : STEP_MM
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const d = delta[event.key]
    if (!d) return
    event.preventDefault()
    editing.update(id, clampToPage(x + d[0], y + d[1], width))
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a positioned, draggable canvas element
    <div
      className={`letter-positioned is-editable${selected ? ' is-selected' : ''}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      onPointerDown={start('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={keys}
      onFocus={() => editing.select(id)}
    >
      {children}
      {selected ? (
        <span
          className="resize-handle"
          aria-hidden="true"
          title={editing.labels.resize}
          onPointerDown={start('resize')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ) : null}
    </div>
  )
}
