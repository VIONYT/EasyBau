import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  evaluateFormula,
  evaluateFormulaExact,
  FormulaError,
  type FormulaErrorCode,
  formulaVariables,
  MAX_FORMULA_LENGTH,
  parseFormula,
  tryEvaluateFormula,
} from './formula.js'

function errorCode(formula: string, variables = {}): FormulaErrorCode | undefined {
  const result = tryEvaluateFormula(formula, variables)
  return result.ok ? undefined : result.error.code
}

describe('measurement formulas: reference examples', () => {
  it.each([
    ['4,25*2,60', '11.0500'],
    ['4,25*2,60 - 0,885*2,01', '9.2712'], // wall minus door: 9,27115 → half up
    ['4.25*2.6', '11.0500'], // decimal point also accepted
    ['15+5+10', '30.0000'],
    ['13+8', '21.0000'],
    ['2*(4,25+3,10)*2,60', '38.2200'], // wall area of a room
    ['(3+2)/2*1,5', '3.7500'], // trapezoid
    ['10 : 4', '2.5000'], // ":" as division
    ['10 ÷ 4', '2.5000'],
    ['4,25 × 2', '8.5000'],
    ['4,25 · 2', '8.5000'],
    ['5 − 2', '3.0000'], // unicode minus
    ['5 – 2', '3.0000'], // en dash from copy & paste
    ['-3+5', '2.0000'],
    ['+3', '3.0000'],
    ['--3', '3.0000'],
    ['2^3^2', '512.0000'], // right-associative
    ['-2^2', '-4.0000'], // power binds tighter than unary minus
    ['2^-1', '0.5000'],
    [',5*2', '1.0000'],
    ['1/3', '0.3333'],
    ['2/3', '0.6667'], // rounded half up to 4 decimals
    ['0,00005', '0.0001'],
    ['  12  ', '12.0000'],
  ])('%s = %s', (formula, expected) => {
    expect(evaluateFormula(formula)).toBe(expected)
  })

  it('keeps full precision until the final rounding', () => {
    expect(evaluateFormulaExact('1/3*3').toFixed(4)).toBe('1.0000')
    expect(evaluateFormula('0,1+0,2')).toBe('0.3000')
  })

  it('evaluates functions with ";" as argument separator', () => {
    expect(evaluateFormula('pi*0,5^2')).toBe('0.7854')
    expect(evaluateFormula('pi()*2')).toBe('6.2832')
    expect(evaluateFormula('sqrt(16)')).toBe('4.0000')
    expect(evaluateFormula('abs(-2,5)')).toBe('2.5000')
    expect(evaluateFormula('round(2,345; 2)')).toBe('2.3500')
    expect(evaluateFormula('round(2,5)')).toBe('3.0000')
    expect(evaluateFormula('ceil(150/25,5)')).toBe('6.0000')
    expect(evaluateFormula('floor(5,9)')).toBe('5.0000')
    expect(evaluateFormula('min(3; 1,5; 2)')).toBe('1.5000')
    expect(evaluateFormula('MAX(3; 7)')).toBe('7.0000')
  })

  it('resolves room variables case-insensitively and accepts German number strings', () => {
    const room = { L: '4,25', B: 3.1, H: '2,60' }
    expect(evaluateFormula('2*(L+B)*H', room)).toBe('38.2200')
    expect(evaluateFormula('l*b', room)).toBe('13.1750')
    expect(evaluateFormula('Länge*2', { länge: '1,5' })).toBe('3.0000')
  })

  it('explains the allowed argument count', () => {
    const result = tryEvaluateFormula('round(1; 2; 3)')
    expect(result.ok ? '' : result.error.message).toBe('round() erwartet 1 bis 2 Wert(e).')
  })

  it('finds variables inside unary expressions', () => {
    expect(formulaVariables('-H+1')).toEqual(['h'])
  })

  it('lists used variables without constants', () => {
    expect(formulaVariables('2*(L+B)*H - pi*r^2 + round(L; 2)').sort()).toEqual([
      'b',
      'h',
      'l',
      'r',
    ])
  })

  it('returns a parse tree', () => {
    expect(parseFormula('1+2*3')).toMatchObject({
      kind: 'binary',
      op: '+',
      right: { kind: 'binary', op: '*' },
    })
  })
})

describe('measurement formulas: errors with German messages', () => {
  it.each<[string, FormulaErrorCode]>([
    ['', 'empty'],
    ['   ', 'empty'],
    ['4,25*', 'unexpected_end'],
    ['(4+2', 'unexpected_end'],
    ['4+2)', 'unexpected_token'],
    ['4 2', 'missing_operator'],
    ['2(3+4)', 'missing_operator'],
    ['2 L', 'missing_operator'],
    ['*3', 'unexpected_token'],
    [')', 'unexpected_token'],
    [';', 'unexpected_token'],
    ['4,25,3', 'unexpected_character'],
    ['4.', 'unexpected_character'],
    ['4 & 2', 'unexpected_character'],
    ['alert(1)', 'unknown_function'],
    ['X*2', 'unknown_variable'],
    ['sqrt(1; 2)', 'wrong_argument_count'],
    ['sqrt()', 'wrong_argument_count'],
    ['pi(1)', 'wrong_argument_count'],
    ['round(1; 9)', 'invalid_result'],
    ['round(1; 1,5)', 'invalid_result'],
    ['sqrt(-1)', 'invalid_result'],
    ['5/0', 'division_by_zero'],
    ['5/(2-2)', 'division_by_zero'],
    ['0^-1', 'division_by_zero'],
    ['2^0,5', 'invalid_result'],
    ['2^11', 'invalid_result'],
    ['10^10*10^10', 'invalid_result'], // result too large
    ['sqrt(4', 'unexpected_end'],
    ['min(1 2)', 'unexpected_token'],
  ])('%j → %s', (formula, code) => {
    expect(errorCode(formula)).toBe(code)
  })

  it('reports the position of the problem', () => {
    const result = tryEvaluateFormula('4,25 * 2,6 x')
    expect(result).toMatchObject({ ok: false, error: { code: 'missing_operator', position: 11 } })
  })

  it('omits the position when it is unknown', () => {
    const result = tryEvaluateFormula('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect('position' in result.error).toBe(false)
  })

  it('rejects invalid room values gracefully', () => {
    expect(errorCode('L*2', { L: 'abc' })).toBe('invalid_result')
  })

  it('limits length, token count and nesting depth', () => {
    expect(errorCode('1'.repeat(MAX_FORMULA_LENGTH + 1))).toBe('too_long')
    expect(errorCode(Array.from({ length: 220 }, () => '1').join('+'))).toBe('too_complex')
    expect(errorCode(`${'('.repeat(60)}1${')'.repeat(60)}`)).toBe('too_complex')
  })

  it('throws FormulaError from the throwing API', () => {
    expect(() => evaluateFormula('1+')).toThrow(FormulaError)
    expect(() => evaluateFormula('1+')).toThrow(/unvollständig/)
  })

  it('rethrows unexpected errors', () => {
    const evil = {}
    Object.defineProperty(evil, 'L', {
      enumerable: true,
      get() {
        throw new TypeError('boom')
      },
    })
    expect(() => tryEvaluateFormula('L', evil)).toThrow(TypeError)
  })
})

describe('measurement formulas: fuzzing', () => {
  it('never throws anything but a result or a FormulaError for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (input) => {
        const result = tryEvaluateFormula(input, { L: '4,25', B: '3' })
        if (result.ok) expect(result.quantity).toMatch(/^-?\d+\.\d{4}$/)
        else expect(typeof result.error.message).toBe('string')
      }),
      { numRuns: 2000 },
    )
  })

  it('never executes code: identifiers are only looked up, never evaluated', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'constructor',
          'process',
          'globalThis',
          '__proto__',
          'eval',
          'Function',
          'toString',
        ),
        (name) => {
          expect(errorCode(name)).toBe('unknown_variable')
          expect(errorCode(`${name}(1)`)).toBe('unknown_function')
        },
      ),
    )
  })

  it('matches exact decimal arithmetic for generated expressions', () => {
    const operand = fc.integer({ min: -9999, max: 9999 }).map((n) => n / 100)
    fc.assert(
      fc.property(operand, operand, operand, (a, b, c) => {
        const fmt = (n: number) => `(${n.toFixed(2).replace('.', ',')})`
        const expected = Math.round((a * 100 + b * 100) * c * 100) / 10000
        expect(Number(evaluateFormula(`(${fmt(a)}+${fmt(b)})*${fmt(c)}`))).toBeCloseTo(expected, 4)
      }),
      { numRuns: 500 },
    )
  })
})
