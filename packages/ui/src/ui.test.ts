import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Amount, Badge, Button, Field, formatEuro, Notice } from './index.js'
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
