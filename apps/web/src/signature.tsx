import type { MySignature, UploadedSignature } from '@easybau/schemas'
import { paper } from '@easybau/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, uploadFile } from './api'
import { FormError } from './forms'
import { t } from './i18n'

/**
 * Handwritten signatures: drawn in the browser with pen (pressure), finger or mouse, uploaded as
 * trimmed PNG. A user can keep one in the account; later documents start with that copy.
 */

interface Point {
  x: number
  y: number
  width: number
}

const INK = paper.ink
const PAD_HEIGHT = 180
const EXPORT_SCALE = 2
const EXPORT_PADDING = 8

const widthOf = (event: PointerEvent | React.PointerEvent) =>
  // Pen: thin to bold with pressure; finger/mouse report no useful pressure.
  event.pointerType === 'pen' ? 1 + 3 * Math.max(0.1, event.pressure) : 2.4

function paint(context: CanvasRenderingContext2D, strokes: Point[][]) {
  context.strokeStyle = INK
  context.fillStyle = INK
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const stroke of strokes) {
    const [first] = stroke
    if (!first) continue
    if (stroke.length === 1) {
      context.beginPath()
      context.arc(first.x, first.y, first.width / 2, 0, Math.PI * 2)
      context.fill()
      continue
    }
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1] as Point
      const b = stroke[i] as Point
      context.lineWidth = (a.width + b.width) / 2
      context.beginPath()
      context.moveTo(a.x, a.y)
      context.lineTo(b.x, b.y)
      context.stroke()
    }
  }
}

/** Renders the strokes cropped to their bounds on a transparent background. */
function exportPng(strokes: Point[][]): Promise<Blob | null> {
  const points = strokes.flat()
  if (!points.length) return Promise.resolve(null)
  const pad = EXPORT_PADDING
  const minX = Math.min(...points.map((p) => p.x - p.width)) - pad
  const minY = Math.min(...points.map((p) => p.y - p.width)) - pad
  const maxX = Math.max(...points.map((p) => p.x + p.width)) + pad
  const maxY = Math.max(...points.map((p) => p.y + p.width)) + pad
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((maxX - minX) * EXPORT_SCALE)
  canvas.height = Math.ceil((maxY - minY) * EXPORT_SCALE)
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)
  context.scale(EXPORT_SCALE, EXPORT_SCALE)
  context.translate(-minX, -minY)
  paint(context, strokes)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

/** Drawing area for a signature (touch-action: none, so the page does not scroll while signing). */
export function SignaturePad({
  id,
  label,
  onChange,
}: {
  id: string
  label: string
  onChange: (png: Blob | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Point[][]>([])
  const active = useRef<number | null>(null)
  const [empty, setEmpty] = useState(true)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const ratio = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    if (canvas.width !== Math.round(width * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(PAD_HEIGHT * ratio)
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, PAD_HEIGHT)
    paint(context, strokes.current)
  }, [])

  useEffect(() => {
    redraw()
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(redraw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [redraw])

  const pointOf = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: widthOf(event) }
  }

  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (active.current !== null || (event.pointerType === 'mouse' && event.button !== 0)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    active.current = event.pointerId
    strokes.current.push([pointOf(event)])
    setEmpty(false)
    redraw()
  }
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (active.current !== event.pointerId) return
    const stroke = strokes.current.at(-1)
    if (!stroke) return
    // Coalesced events keep pen strokes smooth on fast tablets.
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]
    const rect = event.currentTarget.getBoundingClientRect()
    for (const e of events.length ? events : [event.nativeEvent]) {
      stroke.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, width: widthOf(e) })
    }
    redraw()
  }
  const up = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (active.current !== event.pointerId) return
    active.current = null
    void exportPng(strokes.current).then(onChange)
  }
  const clear = () => {
    strokes.current = []
    active.current = null
    setEmpty(true)
    redraw()
    onChange(null)
  }

  return (
    <div className="signature-pad">
      <span className="signature-pad__label" id={`${id}-label`}>
        {label}
      </span>
      <div className="signature-pad__area">
        <canvas
          ref={canvasRef}
          id={id}
          role="img"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          style={{ height: PAD_HEIGHT }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <span className="signature-pad__line" aria-hidden="true" />
      </div>
      <div className="signature-pad__actions">
        <span className="hint" id={`${id}-hint`}>
          {empty ? t('sig.drawHint') : t('sig.drawn')}
        </span>
        <button type="button" className="button ghost auto" onClick={clear} disabled={empty}>
          {t('sig.clear')}
        </button>
      </div>
    </div>
  )
}

export function SignatureImage({ url, alt }: { url: string; alt: string }) {
  return <img className="signature-image" src={url} alt={alt} />
}

/** The signature kept in the user's account (undefined while loading). */
export function useMySignature() {
  const [signature, setSignature] = useState<MySignature | null | undefined>(undefined)
  useEffect(() => {
    api<{ signature: MySignature | null }>('GET', '/api/v1/me/signature')
      .then((r) => setSignature(r.signature))
      .catch(() => setSignature(null))
  }, [])
  return [signature, setSignature] as const
}

/** How a signer signs: with the copy from the account or with a freshly drawn signature. */
export type SignatureChoice =
  | { mode: 'stored' }
  | { mode: 'drawn'; png: Blob | null; keep: boolean }

export const initialChoice = (own: boolean): SignatureChoice =>
  own ? { mode: 'stored' } : { mode: 'drawn', png: null, keep: false }

async function upload(png: Blob): Promise<string> {
  return (await uploadFile<UploadedSignature>('/api/v1/signatures', png)).assetId
}

/**
 * Asset id for the sign request: the stored copy, or the drawn one (uploaded now and, if wanted,
 * kept in the account for later documents). null = sign by name only.
 */
export async function resolveSignature(
  choice: SignatureChoice,
  mine: MySignature | null | undefined,
): Promise<string | null> {
  if (choice.mode === 'stored') return mine?.assetId ?? null
  if (!choice.png) return null
  const assetId = await upload(choice.png)
  if (choice.keep) await api('PUT', '/api/v1/me/signature', { assetId })
  return assetId
}

/**
 * Signature of one signer in a sign dialog. `own`: the signed-in user signs (stored copy offered,
 * a new drawing can be kept in the account); otherwise e.g. the client draws on site.
 */
export function SignatureInput({
  id,
  label,
  own,
  mine,
  choice,
  onChange,
}: {
  id: string
  label: string
  own: boolean
  mine: MySignature | null | undefined
  choice: SignatureChoice
  onChange: (choice: SignatureChoice) => void
}) {
  if (own && mine && choice.mode === 'stored') {
    return (
      <div className="signature-pad">
        <span className="signature-pad__label">{label}</span>
        <div className="signature-stored">
          <SignatureImage url={mine.url} alt={t('sig.mine')} />
        </div>
        <div className="signature-pad__actions">
          <span className="hint">{t('sig.fromAccount')}</span>
          <button
            type="button"
            className="button ghost auto"
            onClick={() => onChange({ mode: 'drawn', png: null, keep: true })}
          >
            {t('sig.redraw')}
          </button>
        </div>
      </div>
    )
  }
  const keep = choice.mode === 'drawn' ? choice.keep : own
  return (
    <div>
      <SignaturePad
        id={id}
        label={label}
        onChange={(png) => onChange({ mode: 'drawn', png, keep })}
      />
      {own ? (
        <label className="check">
          <input
            type="checkbox"
            checked={keep}
            onChange={(e) =>
              onChange({
                mode: 'drawn',
                png: choice.mode === 'drawn' ? choice.png : null,
                keep: e.target.checked,
              })
            }
          />
          <span>{t('sig.keep')}</span>
        </label>
      ) : null}
      {own && mine ? (
        <button
          type="button"
          className="button ghost auto"
          onClick={() => onChange({ mode: 'stored' })}
        >
          {t('sig.useStored')}
        </button>
      ) : null}
    </div>
  )
}

/** Einstellungen › Sicherheit: draw, replace or remove the own signature. */
export function MySignatureCard() {
  const [mine, setMine] = useMySignature()
  const [png, setPng] = useState<Blob | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [padKey, setPadKey] = useState(0)

  const save = async () => {
    if (!png) return
    setBusy(true)
    setError(null)
    try {
      const assetId = await upload(png)
      const result = await api<{ signature: MySignature | null }>('PUT', '/api/v1/me/signature', {
        assetId,
      })
      setMine(result.signature)
      setEditing(false)
      setPng(null)
      setPadKey((k) => k + 1)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!window.confirm(t('sig.removeConfirm'))) return
    setBusy(true)
    setError(null)
    try {
      await api('DELETE', '/api/v1/me/signature')
      setMine(null)
      setSaved(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <h2>{t('sig.title')}</h2>
      <p className="hint">{t('sig.intro')}</p>
      <FormError>{error}</FormError>
      {saved ? (
        <p className="success" role="status">
          {t('sig.saved')}
        </p>
      ) : null}
      {mine === undefined ? <p className="muted">{t('common.loading')}</p> : null}
      {mine && !editing ? (
        <>
          <div className="signature-stored">
            <SignatureImage url={mine.url} alt={t('sig.mine')} />
          </div>
          <div className="actions">
            <button
              type="button"
              className="button ghost auto"
              onClick={() => {
                setEditing(true)
                setSaved(false)
              }}
            >
              {t('sig.redraw')}
            </button>
            <button type="button" className="button ghost auto" onClick={remove} disabled={busy}>
              {t('sig.remove')}
            </button>
          </div>
        </>
      ) : null}
      {mine === null || editing ? (
        <>
          <SignaturePad key={padKey} id="my-signature" label={t('sig.mine')} onChange={setPng} />
          <div className="actions">
            <button
              type="button"
              className="button primary auto"
              onClick={save}
              disabled={busy || !png}
            >
              {t('sig.save')}
            </button>
            {editing ? (
              <button
                type="button"
                className="button ghost auto"
                onClick={() => {
                  setEditing(false)
                  setPng(null)
                }}
              >
                {t('common.cancel')}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
