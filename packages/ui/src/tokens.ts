/**
 * Design tokens (DESIGN.md §7.2) for code that cannot use CSS variables (canvas, inline SVG,
 * PWA manifest). The same values are the CSS custom properties in tokens.css – a test keeps both
 * in step. Everything else uses the CSS variables, never literal colours or sizes.
 */
export const color = {
  primary: '#0f4c5c',
  onPrimary: '#ffffff',
  accent: '#f28c28',
  bg: '#f8fafc',
  surface: '#ffffff',
  text: '#0f172a',
  muted: '#475569',
  border: '#e2e8f0',
  success: '#15803d',
  warning: '#b45309',
  error: '#b91c1c',
  info: '#1d4ed8',
} as const

/** Schiefer-Grau-Skala (neutral tones). */
export const slate = {
  50: '#f8fafc',
  100: '#f1f5f9',
  200: '#e2e8f0',
  300: '#cbd5e1',
  400: '#94a3b8',
  500: '#64748b',
  600: '#475569',
  700: '#334155',
  800: '#1e293b',
  900: '#0f172a',
} as const

/** The printed sheet (Briefpapier, PDF preview) stays paper-white in dark mode too. */
export const paper = {
  background: '#ffffff',
  text: '#111827',
  muted: '#4b5563',
  soft: '#374151',
  rule: '#9ca3af',
  ruleStrong: '#6b7280',
  line: '#e5e7eb',
  shade: '#f3f4f6',
  /** Brand colours on the sheet (editor handles, selection) – not switched in dark mode. */
  brand: '#0f4c5c',
  focus: '#f28c28',
  watermark: '#b91c1c',
  /** Ink of handwritten signatures (dark blue like a ballpoint pen). */
  ink: '#10203a',
} as const

/** 4-px grid. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const

/** Type scale in px; 16 px is the minimum for running text on phones. */
export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
} as const

/** Touch targets: at least 44 px, on site screens (Baustelle) 56 px. */
export const touch = { min: 44, site: 56 } as const

export const radius = 12
