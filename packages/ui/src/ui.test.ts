import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Amount,
  Badge,
  Button,
  DataTable,
  Dialog,
  Field,
  formatEuro,
  formatEuroInput,
  MoneyField,
  Notice,
  parseEuro,
  UnitField,
} from './index.js'
import { color, fontSize, paper, slate, space, touch } from './tokens.js'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
// Only the light values (before the dark-mode block) must match tokens.ts.
const light = css.slice(0, css.indexOf('@media'))
const cssVar = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(light)?.[1]?.trim()
const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

describe('design tokens', () => {
  it('has the same values in tokens.css and tokens.ts', () => {
    for (const [key, value] of Object.entries(color))
      expect(cssVar(`color-${kebab(key)}`)).toBe(value)
    for (const [key, value] of Object.entries(slate)) expect(cssVar(`slate-${key}`)).toBe(value)
    for (const [key, value] of Object.entries(paper)) {
      expect(cssVar(key === 'background' ? 'paper' : `paper-${kebab(key)}`)).toBe(value)
    }
    for (const [key, value] of Object.entries(space))
      expect(cssVar(`space-${key}`)).toBe(`${value}px`)
    for (const [key, value] of Object.entries(fontSize)) {
      expect(cssVar(`font-size-${key}`)).toBe(`${value}px`)
    }
    expect(cssVar('touch-min')).toBe(`${touch.min}px`)
    expect(cssVar('touch-site')).toBe(`${touch.site}px`)
  })

  it('redefines every colour for dark mode except the paper', () => {
    const dark = css.slice(css.indexOf('@media'))
    for (const key of Object.keys(color)) {
      if (key === 'accent') continue
      expect(dark, key).toContain(`--color-${kebab(key)}:`)
    }
    expect(dark).not.toContain('--paper')
  })
})

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

describe('components', () => {
  it('renders buttons with variant, size and a safe default type', () => {
    expect(html(createElement(Button, { variant: 'primary', full: true }, 'Speichern'))).toBe(
      '<button type="button" class="button primary full">Speichern</button>',
    )
    expect(html(createElement(Button, { variant: 'destructive', site: true }, 'Löschen'))).toBe(
      '<button type="button" class="button danger auto site">Löschen</button>',
    )
    expect(html(createElement(Button, { type: 'submit', className: 'x' }, 'OK'))).toBe(
      '<button type="submit" class="button ghost secondary auto x">OK</button>',
    )
    expect(html(createElement(Button, { variant: 'ghost', size: 'icon', danger: true }, '×'))).toBe(
      '<button type="button" class="button ghost auto icon danger">×</button>',
    )
    expect(html(createElement(Button, { variant: 'primary', width: 'natural' }, 'Los'))).toBe(
      '<button type="button" class="button primary">Los</button>',
    )
    expect(
      html(createElement(Button, { variant: 'ghost', size: 'small', width: 'full' }, 'Mehr')),
    ).toBe('<button type="button" class="button ghost full small">Mehr</button>')
  })

  it('announces errors and successes, not neutral notices', () => {
    expect(html(createElement(Notice, { tone: 'error' }, 'Fehler'))).toContain('role="alert"')
    expect(html(createElement(Notice, { tone: 'success' }, 'OK'))).toContain('role="status"')
    expect(html(createElement(Notice, null, 'Hinweis'))).toBe(
      '<p class="notice notice--info">Hinweis</p>',
    )
    expect(html(createElement(Badge, { tone: 'warning' }, 'Überfällig'))).toBe(
      '<span class="badge badge--warning">Überfällig</span>',
    )
  })

  it('formats amounts in German with tabular figures', () => {
    expect(formatEuro(123456)).toBe('1.234,56 €')
    expect(html(createElement(Amount, { cents: -500, strong: true }))).toBe(
      '<span class="amount amount--strong">-5,00 €</span>',
    )
    expect(html(createElement(Amount, { cents: null }))).toBe('')
  })

  it('links label, hint and error of a field for screen readers', () => {
    const markup = html(
      createElement(Field, {
        label: 'PLZ',
        name: 'postalCode',
        hint: '5 Ziffern',
        error: 'Falsch',
      }),
    )
    const id = /<input id="([^"]+)"/.exec(markup)?.[1]
    expect(markup).toContain(`<label for="${id}">PLZ</label>`)
    expect(markup).toContain(`aria-describedby="${id}-hint ${id}-error"`)
    expect(markup).toContain('aria-invalid="true"')
  })
})

describe('Geldfeld: parseEuro / formatEuroInput', () => {
  it('reads German notation into cents without floats', () => {
    expect(parseEuro('1.234,56')).toBe(123456n)
    expect(parseEuro('1234,5')).toBe(123450n)
    expect(parseEuro('12.5')).toBe(1250n)
    expect(parseEuro('12.500')).toBe(1250000n)
    expect(parseEuro(' 99 € ')).toBe(9900n)
    expect(parseEuro('-0,01')).toBe(-1n)
    expect(parseEuro('')).toBeNull()
    expect(parseEuro('1,234')).toBeUndefined()
    expect(parseEuro('12a')).toBeUndefined()
  })

  it('formats cents for the input', () => {
    expect(formatEuroInput(123456n)).toBe('1.234,56')
    expect(formatEuroInput(5)).toBe('0,05')
    expect(formatEuroInput(-100000)).toBe('-1.000,00')
    expect(formatEuroInput(null)).toBe('')
    for (const cents of [0n, 1n, 99n, 100n, 123456789n, -42n]) {
      expect(parseEuro(formatEuroInput(cents))).toBe(cents)
    }
  })
})

describe('further components', () => {
  it('renders money and unit fields with the suffix announced to screen readers', () => {
    const html = renderToStaticMarkup(
      createElement(MoneyField, { label: 'Betrag', name: 'amount', invalidText: 'Ungültig' }),
    )
    expect(html).toContain('inputMode="decimal"')
    expect(html).toContain('class="input-affix__suffix"')
    expect(html).toMatch(/aria-describedby="[^"]*suffix/)
    expect(
      renderToStaticMarkup(
        createElement(UnitField, { label: 'Fläche', name: 'qty', suffix: 'm²' }),
      ),
    ).toContain('m²')
  })

  it('renders a table with a header row and numeric columns', () => {
    const html = renderToStaticMarkup(
      createElement(DataTable<{ id: string; name: string; cents: number }>, {
        caption: 'Rechnungen',
        rowKey: (r) => r.id,
        rows: [{ id: '1', name: 'R-1', cents: 100 }],
        columns: [
          { key: 'name', header: 'Nummer', cell: (r) => r.name },
          { key: 'sum', header: 'Betrag', cell: (r) => formatEuro(r.cents), numeric: true },
        ],
      }),
    )
    expect(html).toContain('<th scope="col" class="numeric">Betrag</th>')
    expect(html).toContain('<caption')
    const empty = renderToStaticMarkup(
      createElement(DataTable<{ id: string }>, {
        caption: 'Leer',
        rowKey: (r) => r.id,
        rows: [],
        columns: [],
        empty: createElement('p', null, 'Keine Einträge'),
      }),
    )
    expect(empty).toBe('<p>Keine Einträge</p>')
  })

  it('renders a dialog with an accessible title and close button', () => {
    const html = renderToStaticMarkup(
      createElement(Dialog, {
        open: false,
        title: 'Zahlung',
        onClose: () => undefined,
        closeLabel: 'Schließen',
        // biome-ignore lint/correctness/noChildrenProp: the props type requires children.
        children: 'Inhalt',
      }),
    )
    expect(html).toContain('<dialog')
    expect(html).toContain('aria-label="Schließen"')
    expect(html).toMatch(/aria-labelledby="[^"]+"/)
  })

  it('defines high-contrast colours for light and dark mode', () => {
    const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
    expect(tokens).toContain(':root[data-contrast="high"]')
    expect(tokens).toContain('prefers-contrast: more')
  })
})
