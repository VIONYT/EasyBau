/**
 * Hoher Kontrast for site work in sunlight: a display preference of this device (localStorage,
 * no account data). "system" follows the operating system setting (prefers-contrast).
 */
export type ContrastMode = 'system' | 'high' | 'normal'
const KEY = 'easybau.contrast'

export function readContrast(): ContrastMode {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'high' || value === 'normal' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyContrast(mode: ContrastMode = readContrast()) {
  const root = document.documentElement
  if (mode === 'system') delete root.dataset.contrast
  else root.dataset.contrast = mode
}

export function saveContrast(mode: ContrastMode) {
  try {
    if (mode === 'system') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, mode)
  } catch {
    // Private mode: the choice applies until the page is reloaded.
  }
  applyContrast(mode)
}
