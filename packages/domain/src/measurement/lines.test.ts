import { describe, expect, it } from 'vitest'
import {
  billableQuantity,
  measurementLineQuantity,
  quantitiesByItem,
  quantityVariance,
  sumQuantities,
} from './lines.js'
import { applyTemplate, MEASUREMENT_TEMPLATES, templatesForDimension } from './templates.js'

describe('measurement lines', () => {
  const bathroom = { L: '3,10', B: '2,40', H: '2,60' }

  it('computes a wall area of a room minus a door (reference example)', () => {
    const wall = measurementLineQuantity({ formula: '2*(L+B)*H', locationVariables: bathroom })
    const door = measurementLineQuantity({ formula: '0,885*2,01', isDeduction: true })
    expect(wall).toBe('28.60')
    // 0,885 × 2,01 = 1,77885 → rounded half up to two decimals
    expect(door).toBe('-1.78')
    expect(sumQuantities([wall, door])).toBe('26.8200')
  })

  it('treats deductions as negative even if entered negative', () => {
    expect(measurementLineQuantity({ formula: '-2', isDeduction: true })).toBe('-2.00')
  })

  it('lets line variables override room variables', () => {
    expect(
      measurementLineQuantity({ formula: 'L*B', locationVariables: bathroom, variables: { L: 1 } }),
    ).toBe('2.40')
  })

  it('rounds results half up to two decimals (34,657 → 34,66; 0,005 → 0,01)', () => {
    expect(measurementLineQuantity({ formula: '34,657' })).toBe('34.66')
    expect(measurementLineQuantity({ formula: '0,005' })).toBe('0.01')
    expect(measurementLineQuantity({ formula: '0,005', isDeduction: true })).toBe('-0.01')
    expect(measurementLineQuantity({ formula: '0,004' })).toBe('0.00')
  })

  it('rounds to the decimals of the unit (m³ and t: 3, Stück: 0)', () => {
    expect(measurementLineQuantity({ formula: '1,2345*2', decimals: 3 })).toBe('2.469')
    expect(measurementLineQuantity({ formula: '0,0005', decimals: 3 })).toBe('0.001')
    expect(measurementLineQuantity({ formula: '2,5', decimals: 0 })).toBe('3')
    expect(measurementLineQuantity({ formula: '2,5', isDeduction: true, decimals: 0 })).toBe('-3')
  })

  it('sums an empty list to zero', () => {
    expect(sumQuantities([])).toBe('0.0000')
  })

  it('groups quantities per document item and skips unassigned lines', () => {
    const totals = quantitiesByItem([
      { documentItemId: 'a', quantity: '10.5' },
      { documentItemId: 'b', quantity: '3' },
      { documentItemId: 'a', quantity: '-0.5' },
      { documentItemId: null, quantity: '99' },
    ])
    expect(Object.fromEntries(totals)).toEqual({ a: '10.0000', b: '3.0000' })
  })
})

describe('quantity progression (Mengenfortschreibung)', () => {
  it('bills measured to date minus already billed', () => {
    expect(billableQuantity('120,5', '80')).toBe('40.5000')
    expect(billableQuantity('80', '80')).toBe('0.0000')
  })

  it('returns a negative quantity when more was billed than measured', () => {
    expect(billableQuantity('75', '80')).toBe('-5.0000')
  })
})

describe('quantity variance (VOB/B § 2 Abs. 3)', () => {
  it('flags more than +10 %', () => {
    expect(quantityVariance('100', '112')).toEqual({
      difference: '12.0000',
      percent: '12.00',
      direction: 'more',
      exceedsThreshold: true,
    })
  })

  it('does not flag exactly 10 %', () => {
    expect(quantityVariance('100', '110').exceedsThreshold).toBe(false)
    expect(quantityVariance('100', '90').exceedsThreshold).toBe(false)
  })

  it('flags less than −10 %', () => {
    expect(quantityVariance('50', '40')).toMatchObject({
      direction: 'less',
      percent: '-20.00',
      exceedsThreshold: true,
    })
  })

  it('handles equal and zero contract quantities', () => {
    expect(quantityVariance('5', '5')).toMatchObject({
      direction: 'equal',
      exceedsThreshold: false,
    })
    expect(quantityVariance('0', '3')).toEqual({
      difference: '3.0000',
      percent: null,
      direction: 'more',
      exceedsThreshold: true,
    })
    expect(quantityVariance('0', '0')).toMatchObject({
      direction: 'equal',
      exceedsThreshold: false,
    })
  })
})

describe('measurement templates', () => {
  const byId = (id: string) =>
    MEASUREMENT_TEMPLATES.find((t) => t.id === id) as (typeof MEASUREMENT_TEMPLATES)[number]

  it('fills values in German notation', () => {
    expect(applyTemplate(byId('wall_area'), { L: '4.2500', B: '3,1', H: '2,60' })).toBe(
      '2*(4,25+3,1)*2,6',
    )
    expect(applyTemplate(byId('rectangle'), { L: '5', B: '2.0000' })).toBe('5*2')
  })

  it('keeps variable names for missing values (resolved from the room later)', () => {
    expect(applyTemplate(byId('volume'), { L: '2', B: '', H: undefined })).toBe('2*B*H')
  })

  it('produces formulas the parser understands', () => {
    for (const template of MEASUREMENT_TEMPLATES) {
      const values = Object.fromEntries(template.variables.map((v) => [v, '2']))
      expect(() =>
        measurementLineQuantity({ formula: applyTemplate(template, values) }),
      ).not.toThrow()
    }
  })

  it('filters by dimension of the item unit', () => {
    expect(templatesForDimension('volume').map((t) => t.id)).toEqual(['volume', 'cylinder'])
    expect(templatesForDimension(undefined)).toBe(MEASUREMENT_TEMPLATES)
    expect(byId('opening').isDeduction).toBe(true)
  })
})
