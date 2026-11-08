import type { Dimension } from '../units.js'

/**
 * Formula templates for the measurement keyboard (DESIGN.md §7.3, „Vorlagen-Chips“).
 * Templates only produce formula text; evaluation always goes through the parser.
 */
export interface MeasurementTemplate {
  id: string
  label: string
  dimension: Dimension
  /** Variable names the template needs, in input order. */
  variables: readonly string[]
  /** Formula using the variable names, e.g. "2*(L+B)*H". */
  formula: string
  isDeduction?: boolean
}

export const MEASUREMENT_TEMPLATES: readonly MeasurementTemplate[] = [
  { id: 'length', label: 'Länge', dimension: 'length', variables: ['L'], formula: 'L' },
  { id: 'rectangle', label: 'Rechteck', dimension: 'area', variables: ['L', 'B'], formula: 'L*B' },
  {
    id: 'wall_area',
    label: 'Wandfläche (Raumumfang × Höhe)',
    dimension: 'area',
    variables: ['L', 'B', 'H'],
    formula: '2*(L+B)*H',
  },
  {
    id: 'perimeter',
    label: 'Raumumfang',
    dimension: 'length',
    variables: ['L', 'B'],
    formula: '2*(L+B)',
  },
  { id: 'triangle', label: 'Dreieck', dimension: 'area', variables: ['G', 'H'], formula: 'G*H/2' },
  {
    id: 'trapezoid',
    label: 'Trapez',
    dimension: 'area',
    variables: ['A', 'C', 'H'],
    formula: '(A+C)/2*H',
  },
  { id: 'circle', label: 'Kreis', dimension: 'area', variables: ['R'], formula: 'pi*R^2' },
  {
    id: 'volume',
    label: 'Volumen (Quader)',
    dimension: 'volume',
    variables: ['L', 'B', 'H'],
    formula: 'L*B*H',
  },
  {
    id: 'cylinder',
    label: 'Volumen (Zylinder)',
    dimension: 'volume',
    variables: ['R', 'H'],
    formula: 'pi*R^2*H',
  },
  { id: 'count', label: 'Stück', dimension: 'count', variables: ['N'], formula: 'N' },
  {
    id: 'opening',
    label: 'Abzug Öffnung (Tür/Fenster)',
    dimension: 'area',
    variables: ['B', 'H'],
    formula: 'B*H',
    isDeduction: true,
  },
] as const

/** Formats a decimal string for formulas the German way: "4.2500" → "4,25". */
function germanNumber(value: string): string {
  const [int, frac = ''] = value.split('.')
  const trimmed = frac.replace(/0+$/, '')
  return trimmed ? `${int},${trimmed}` : (int as string)
}

/**
 * Fills a template with concrete numbers, e.g. wall_area + {L:"4,25",B:"3,1",H:"2,6"}
 * → "2*(4,25+3,1)*2,6". Missing values keep the variable name (resolved from the room later).
 */
export function applyTemplate(
  template: MeasurementTemplate,
  values: Record<string, string | undefined>,
): string {
  return template.formula.replace(/[A-Z]/g, (name) => {
    const value = values[name]
    return value === undefined || value.trim() === ''
      ? name
      : germanNumber(value.trim().replace(',', '.'))
  })
}

/** Which templates fit an item unit; the editor shows these first. */
export function templatesForDimension(
  dimension: Dimension | undefined,
): readonly MeasurementTemplate[] {
  if (!dimension) return MEASUREMENT_TEMPLATES
  return MEASUREMENT_TEMPLATES.filter((t) => t.dimension === dimension)
}
