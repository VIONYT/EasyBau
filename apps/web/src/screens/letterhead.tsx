import { DIN5008B, defaultLetterhead, LETTERHEAD_FIELDS } from '@opc/domain'
import type { LetterheadLayout, LetterheadSettings } from '@opc/schemas'
import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, api, uploadFile } from '../api'
import { FormError } from '../forms'
import { t } from '../i18n'
import { type LetterEditing, LetterPage, ScaledPage } from '../letter'

type Text = LetterheadLayout['texts'][number]

/**
 * Briefpapier-Editor (WYSIWYG): the A4 page per DIN 5008 Form B exactly as it is printed.
 * Logo and texts of the Briefkopf are moved with mouse, finger or arrow keys; texts use
 * placeholders such as {Firma} or {IBAN} that are filled from Einstellungen › Firma.
 */
export function LetterheadEditor({ canEdit }: { canEdit: boolean }) {
  const [values, setValues] = useState<Record<string, string | null>>({})
  const [layout, setLayout] = useState<LetterheadLayout | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    api<LetterheadSettings>('GET', '/api/v1/settings/letterhead')
      .then((s) => {
        setLayout(s.layout)
        setValues(s.values)
      })
      .catch((err: ApiError) => setError(err.message))
  }, [])

  if (!layout)
    return error ? <FormError>{error}</FormError> : <p className="muted">{t('common.loading')}</p>

  const change = (next: LetterheadLayout) => {
    setLayout(next)
    setDirty(true)
    setMessage(null)
  }
  const updateText = (id: string, patch: Partial<Text>) =>
    change({ ...layout, texts: layout.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)) })
  const updatePosition: LetterEditing['update'] = (id, patch) => {
    if (id === 'logo' && layout.logo) change({ ...layout, logo: { ...layout.logo, ...patch } })
    else updateText(id, patch)
  }
  const addText = () => {
    const id = `text-${Date.now().toString(36)}`
    change({
      ...layout,
      texts: [
        ...layout.texts,
        {
          id,
          x: 25,
          y: 20,
          width: 70,
          text: t('lh.newText'),
          fontSize: 10,
          bold: false,
          align: 'left',
          color: '#111827',
        },
      ],
    })
    setSelected(id)
  }
  const uploadLogo = async (file: File) => {
    setError(null)
    try {
      const { assetId } = await uploadFile<{ assetId: string }>(
        '/api/v1/settings/letterhead/logo',
        file,
      )
      change({ ...layout, logo: { assetId, x: 25, y: 10, width: 45 } })
      setSelected('logo')
    } catch (err) {
      setError((err as ApiError).message)
    }
  }
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = await api<LetterheadSettings>('PUT', '/api/v1/settings/letterhead', layout)
      setLayout(saved.layout)
      setValues(saved.values)
      setDirty(false)
      setMessage(t('lh.saved'))
    } catch (err) {
      const e = err as ApiError
      setError([e.message, ...Object.values(e instanceof ApiError ? e.fieldErrors : {})].join(' '))
    } finally {
      setBusy(false)
    }
  }

  const selectedText = layout.texts.find((x) => x.id === selected) ?? null
  const editing: LetterEditing | undefined = canEdit
    ? {
        selected,
        select: setSelected,
        update: updatePosition,
        scale,
        labels: { logo: t('lh.logo'), text: t('lh.textField'), resize: t('lh.resize') },
      }
    : undefined
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="panel letterhead-editor">
      <h2>{t('lh.title')}</h2>
      <p className="hint">{t('lh.hint')}</p>
      <div className="lh-toolbar">
        <label className="lh-tool">
          <span>{t('lh.paper')}</span>
          <select className="select" value={layout.paper} disabled>
            <option value="A4">{t('lh.paperA4')}</option>
          </select>
        </label>
        <label className="lh-tool">
          <span>{t('lh.font')}</span>
          <select
            className="select"
            value={layout.font}
            onChange={(e) => change({ ...layout, font: e.target.value as 'sans' | 'serif' })}
          >
            <option value="sans">{t('lh.fontSans')}</option>
            <option value="serif">{t('lh.fontSerif')}</option>
          </select>
        </label>
        <label className="lh-tool">
          <span>{t('lh.accent')}</span>
          <input
            type="color"
            value={layout.accentColor}
            onChange={(e) => change({ ...layout, accentColor: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={layout.foldMarks}
            onChange={(e) => change({ ...layout, foldMarks: e.target.checked })}
          />
          {t('lh.foldMarks')}
        </label>
      </div>
      {canEdit ? (
        <div className="button-row">
          <button type="button" className="button ghost small" onClick={addText}>
            {t('lh.addText')}
          </button>
          <label className="button ghost small file-button">
            {layout.logo ? t('lh.replaceLogo') : t('lh.uploadLogo')}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="visually-hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void uploadLogo(file)
              }}
            />
          </label>
        </div>
      ) : null}

      <div className="letterhead-workspace">
        <div className="letterhead-canvas">
          <ScaledPage onScale={setScale}>
            <LetterPage
              layout={layout}
              values={values}
              recipient={t('lh.sampleRecipient').split('\n')}
              info={[
                { label: t('print.number'), value: t('lh.sampleNumber') },
                { label: t('print.date'), value: today.split('-').reverse().join('.') },
                { label: t('lh.sampleCustomer'), value: 'K-10001' },
              ]}
              editing={editing}
            >
              <h1 className="letter-title">
                {t('doc.invoice.standard')} {t('lh.sampleNumber')}
              </h1>
              <p className="letter-subject">{t('lh.sampleSubject')}</p>
              <p>{t('lh.sampleText')}</p>
            </LetterPage>
          </ScaledPage>
        </div>

        <div className="letterhead-inspector">
          {selectedText ? (
            <TextInspector
              key={selectedText.id}
              text={selectedText}
              disabled={!canEdit}
              onChange={(patch) => updateText(selectedText.id, patch)}
              onRemove={() => {
                change({ ...layout, texts: layout.texts.filter((x) => x.id !== selectedText.id) })
                setSelected(null)
              }}
            />
          ) : selected === 'logo' && layout.logo ? (
            <section aria-label={t('lh.logo')}>
              <h3>{t('lh.logo')}</h3>
              <Position
                value={layout.logo}
                disabled={!canEdit}
                onChange={(patch) => updatePosition('logo', patch)}
              />
              <button
                type="button"
                className="button ghost danger small"
                onClick={() => {
                  change({ ...layout, logo: null })
                  setSelected(null)
                }}
              >
                {t('lh.removeLogo')}
              </button>
            </section>
          ) : (
            <p className="muted">{t('lh.selectHint')}</p>
          )}

          <h3>{t('lh.senderAndFooter')}</h3>
          <TemplateField
            label={t('lh.senderLine')}
            value={layout.senderLine}
            disabled={!canEdit}
            onChange={(senderLine) => change({ ...layout, senderLine })}
          />
          {layout.footer.map((column, index) => (
            <TemplateField
              // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity
              key={index}
              label={`${t('lh.footerColumn')} ${index + 1}`}
              value={column}
              multiline
              disabled={!canEdit}
              onChange={(text) =>
                change({
                  ...layout,
                  footer: layout.footer.map((c, i) => (i === index ? text : c)),
                })
              }
              onRemove={() =>
                change({ ...layout, footer: layout.footer.filter((_, i) => i !== index) })
              }
            />
          ))}
          {canEdit && layout.footer.length < 4 ? (
            <button
              type="button"
              className="button ghost small"
              onClick={() => change({ ...layout, footer: [...layout.footer, ''] })}
            >
              {t('lh.addColumn')}
            </button>
          ) : null}
        </div>
      </div>

      <FormError>{error}</FormError>
      {message ? (
        <p className="success" role="status">
          {message}
        </p>
      ) : null}
      {canEdit ? (
        <div className="button-row">
          <button
            type="button"
            className="button primary auto"
            disabled={busy || !dirty}
            onClick={save}
          >
            {t('common.save')}
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              if (window.confirm(t('lh.resetConfirm'))) {
                change({ ...defaultLetterhead(), logo: layout.logo })
                setSelected(null)
              }
            }}
          >
            {t('lh.reset')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Properties of a text field of the Briefkopf. */
function TextInspector({
  text,
  disabled,
  onChange,
  onRemove,
}: {
  text: Text
  disabled: boolean
  onChange: (patch: Partial<Text>) => void
  onRemove: () => void
}) {
  const id = useId()
  return (
    <section aria-label={t('lh.textField')}>
      <h3>{t('lh.textField')}</h3>
      <TemplateField
        label={t('lh.text')}
        value={text.text}
        multiline
        disabled={disabled}
        onChange={(value) => onChange({ text: value })}
      />
      <div className="row">
        <div className="field">
          <label htmlFor={`${id}-size`}>{t('lh.fontSize')}</label>
          <input
            id={`${id}-size`}
            type="number"
            min={6}
            max={36}
            value={text.fontSize}
            disabled={disabled}
            onChange={(e) =>
              onChange({ fontSize: Math.min(Math.max(Number(e.target.value) || 10, 6), 36) })
            }
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-align`}>{t('lh.align')}</label>
          <select
            id={`${id}-align`}
            className="select"
            value={text.align}
            disabled={disabled}
            onChange={(e) => onChange({ align: e.target.value as Text['align'] })}
          >
            <option value="left">{t('lh.alignLeft')}</option>
            <option value="center">{t('lh.alignCenter')}</option>
            <option value="right">{t('lh.alignRight')}</option>
          </select>
        </div>
      </div>
      <div className="row">
        <label className="check">
          <input
            type="checkbox"
            checked={text.bold}
            disabled={disabled}
            onChange={(e) => onChange({ bold: e.target.checked })}
          />
          {t('lh.bold')}
        </label>
        <div className="field">
          <label htmlFor={`${id}-color`}>{t('lh.color')}</label>
          <input
            id={`${id}-color`}
            type="color"
            value={text.color}
            disabled={disabled}
            onChange={(e) => onChange({ color: e.target.value })}
          />
        </div>
      </div>
      <Position value={text} disabled={disabled} onChange={onChange} />
      {disabled ? null : (
        <button type="button" className="button ghost danger small" onClick={onRemove}>
          {t('lh.removeText')}
        </button>
      )}
    </section>
  )
}

/** X, Y and width in mm (exact input besides dragging). */
function Position({
  value,
  disabled,
  onChange,
}: {
  value: { x: number; y: number; width: number }
  disabled: boolean
  onChange: (patch: { x?: number; y?: number; width?: number }) => void
}) {
  const id = useId()
  const field = (key: 'x' | 'y' | 'width', label: string, max: number, min = 0) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input
        id={`${id}-${key}`}
        type="number"
        step={0.5}
        min={min}
        max={max}
        value={value[key]}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange({ [key]: Math.min(Math.max(n, min), max) })
        }}
      />
    </div>
  )
  return (
    <div className="row three">
      {field('x', t('lh.x'), DIN5008B.page.width - value.width)}
      {field('y', t('lh.y'), DIN5008B.header.height)}
      {field('width', t('lh.width'), DIN5008B.page.width - value.x, 10)}
    </div>
  )
}

/** Text with placeholders; the selected placeholder is inserted at the cursor. */
function TemplateField({
  label,
  value,
  multiline,
  disabled,
  onChange,
  onRemove,
}: {
  label: string
  value: string
  multiline?: boolean
  disabled: boolean
  onChange: (value: string) => void
  onRemove?: () => void
}) {
  const id = useId()
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const insert = (token: string) => {
    const el = ref.current
    const from = el?.selectionStart ?? value.length
    const to = el?.selectionEnd ?? value.length
    onChange(value.slice(0, from) + token + value.slice(to))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(from + token.length, from + token.length)
    })
  }
  return (
    <div className="field template-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea
          id={id}
          ref={ref}
          rows={3}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          ref={ref}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {disabled ? null : (
        <div className="button-row">
          <select
            className="select small"
            aria-label={`${t('lh.insertPlaceholder')} – ${label}`}
            value=""
            onChange={(e) => {
              if (e.target.value) insert(`{${e.target.value}}`)
            }}
          >
            <option value="">{t('lh.insertPlaceholder')}</option>
            {LETTERHEAD_FIELDS.map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
          {onRemove ? (
            <button type="button" className="button ghost small" onClick={onRemove}>
              {t('lh.removeColumn')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
