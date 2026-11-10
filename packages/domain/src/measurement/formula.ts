import { Decimal, type NumericInput, roundQuantity, toDecimal } from '../decimal.js'

/**
 * Measurement formula language (Aufmaß, DESIGN.md §4.3, CLAUDE.md rule 11).
 *
 *   4,25*2,60 - 0,885*2,01      decimal comma or point
 *   2*(L+B)*H                   variables from the room (case-insensitive)
 *   4,25 × 2,60 : 2             ×, · as multiplication; :, ÷ as division
 *   r^2*pi                      power (right-associative), constant pi
 *   round(L*B; 2)               functions; arguments separated by ';' (comma is the decimal sign)
 *
 * Own tokenizer + Pratt parser. Never eval/new Function. Same code runs in browser and server;
 * the server result is authoritative.
 */

export const MAX_FORMULA_LENGTH = 500
const MAX_DEPTH = 50
const MAX_TOKENS = 400

export type FormulaErrorCode =
  | 'empty'
  | 'too_long'
  | 'too_complex'
  | 'unexpected_character'
  | 'unexpected_token'
  | 'unexpected_end'
  | 'missing_operator'
  | 'unknown_variable'
  | 'unknown_function'
  | 'wrong_argument_count'
  | 'division_by_zero'
  | 'invalid_result'

export class FormulaError extends Error {
  override name = 'FormulaError'
  constructor(
    readonly code: FormulaErrorCode,
    message: string,
    /** 0-based character position in the formula, if known. */
    readonly position?: number,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'separator' | 'end'
interface Token {
  type: TokenType
  value: string
  pos: number
}

/** Own-property lookup: never resolve inherited keys like "constructor" or "__proto__" (found by fuzzing). */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

const OPERATOR_ALIASES: Record<string, string> = {
  '+': '+',
  '-': '-',
  '−': '-', // U+2212 minus sign
  '–': '-', // en dash, common from copy & paste
  '*': '*',
  '×': '*',
  '·': '*',
  '/': '/',
  ':': '/',
  '÷': '/',
  '^': '^',
}

const IDENT_START = /[A-Za-zÄÖÜäöüß_]/
const IDENT_PART = /[A-Za-z0-9ÄÖÜäöüß_]/

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i] as string
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[0-9]/.test(ch) || ((ch === ',' || ch === '.') && /[0-9]/.test(input[i + 1] ?? ''))) {
      const start = i
      while (/[0-9]/.test(input[i] ?? '')) i++
      if ((input[i] === ',' || input[i] === '.') && /[0-9]/.test(input[i + 1] ?? '')) {
        i++
        while (/[0-9]/.test(input[i] ?? '')) i++
      }
      if (input[i] === ',' || input[i] === '.') {
        throw new FormulaError('unexpected_character', `Ungültige Zahl an Position ${i + 1}.`, i)
      }
      tokens.push({ type: 'number', value: input.slice(start, i).replace(',', '.'), pos: start })
      continue
    }
    if (IDENT_START.test(ch)) {
      const start = i
      while (IDENT_PART.test(input[i] ?? '')) i++
      tokens.push({ type: 'ident', value: input.slice(start, i), pos: start })
      continue
    }
    const op = own(OPERATOR_ALIASES, ch)
    if (op) {
      tokens.push({ type: 'op', value: op, pos: i++ })
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: ch === '(' ? 'lparen' : 'rparen', value: ch, pos: i++ })
      continue
    }
    if (ch === ';') {
      tokens.push({ type: 'separator', value: ch, pos: i++ })
      continue
    }
    throw new FormulaError(
      'unexpected_character',
      `Unerlaubtes Zeichen „${ch}“ an Position ${i + 1}.`,
      i,
    )
  }
  if (tokens.length > MAX_TOKENS) {
    throw new FormulaError('too_complex', 'Die Formel ist zu lang oder zu komplex.')
  }
  tokens.push({ type: 'end', value: '', pos: input.length })
  return tokens
}

// ---------------------------------------------------------------------------
// Parser (Pratt) → AST
// ---------------------------------------------------------------------------

export type FormulaNode =
  | { kind: 'number'; value: string }
  | { kind: 'variable'; name: string; pos: number }
  | { kind: 'unary'; op: '-' | '+'; operand: FormulaNode }
  | {
      kind: 'binary'
      op: '+' | '-' | '*' | '/' | '^'
      left: FormulaNode
      right: FormulaNode
      pos: number
    }
  | { kind: 'call'; name: string; args: FormulaNode[]; pos: number }

const BINDING_POWER: Record<string, number> = { '+': 10, '-': 10, '*': 20, '/': 20, '^': 40 }
const UNARY_POWER = 30

class Parser {
  private index = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): FormulaNode {
    const node = this.expression(0, 0)
    const next = this.peek()
    if (next.type !== 'end') {
      if (next.type === 'number' || next.type === 'ident' || next.type === 'lparen') {
        throw new FormulaError(
          'missing_operator',
          `Rechenzeichen fehlt vor Position ${next.pos + 1} (z. B. „*“).`,
          next.pos,
        )
      }
      throw new FormulaError(
        'unexpected_token',
        `Unerwartetes „${next.value}“ an Position ${next.pos + 1}.`,
        next.pos,
      )
    }
    return node
  }

  private peek(): Token {
    return this.tokens[this.index] as Token
  }

  private next(): Token {
    return this.tokens[this.index++] as Token
  }

  private expression(minPower: number, depth: number): FormulaNode {
    if (depth > MAX_DEPTH)
      throw new FormulaError('too_complex', 'Die Formel ist zu tief verschachtelt.')
    let left = this.prefix(depth)
    for (;;) {
      const token = this.peek()
      if (token.type !== 'op') break
      const power = BINDING_POWER[token.value] as number
      if (power <= minPower) break
      this.next()
      // '^' is right-associative: parse the right side with a slightly lower power.
      const right = this.expression(token.value === '^' ? power - 1 : power, depth + 1)
      left = { kind: 'binary', op: token.value as '+', left, right, pos: token.pos }
    }
    return left
  }

  private prefix(depth: number): FormulaNode {
    const token = this.next()
    switch (token.type) {
      case 'number':
        return { kind: 'number', value: token.value }
      case 'op':
        if (token.value === '-' || token.value === '+') {
          return {
            kind: 'unary',
            op: token.value,
            operand: this.expression(UNARY_POWER, depth + 1),
          }
        }
        throw new FormulaError(
          'unexpected_token',
          `Unerwartetes „${token.value}“ an Position ${token.pos + 1}.`,
          token.pos,
        )
      case 'lparen': {
        const inner = this.expression(0, depth + 1)
        this.expect('rparen', 'Schließende Klammer „)“ fehlt.')
        return inner
      }
      case 'ident': {
        if (this.peek().type !== 'lparen')
          return { kind: 'variable', name: token.value, pos: token.pos }
        this.next()
        const args: FormulaNode[] = []
        if (this.peek().type !== 'rparen') {
          for (;;) {
            args.push(this.expression(0, depth + 1))
            if (this.peek().type !== 'separator') break
            this.next()
          }
        }
        this.expect('rparen', `Schließende Klammer für „${token.value}(“ fehlt.`)
        return { kind: 'call', name: token.value, args, pos: token.pos }
      }
      case 'end':
        throw new FormulaError('unexpected_end', 'Die Formel ist unvollständig.', token.pos)
      default:
        throw new FormulaError(
          'unexpected_token',
          `Unerwartetes „${token.value}“ an Position ${token.pos + 1}.`,
          token.pos,
        )
    }
  }

  private expect(type: TokenType, message: string): void {
    const token = this.next()
    if (token.type !== type) {
      throw new FormulaError(
        token.type === 'end' ? 'unexpected_end' : 'unexpected_token',
        message,
        token.pos,
      )
    }
  }
}

/** Parses a formula into an AST (throws FormulaError with a German message). */
export function parseFormula(formula: string): FormulaNode {
  if (formula.length > MAX_FORMULA_LENGTH) {
    throw new FormulaError(
      'too_long',
      `Die Formel darf höchstens ${MAX_FORMULA_LENGTH} Zeichen lang sein.`,
    )
  }
  if (formula.trim() === '')
    throw new FormulaError('empty', 'Bitte eine Formel oder Zahl eingeben.')
  return new Parser(tokenize(formula)).parse()
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type FormulaVariables = Record<string, NumericInput>

const CONSTANTS: Record<string, Decimal> = {
  pi: Decimal.acos(-1),
}

type FunctionImpl = { arity: [number, number]; fn: (args: Decimal[], pos: number) => Decimal }

const FUNCTIONS: Record<string, FunctionImpl> = {
  sqrt: {
    arity: [1, 1],
    fn: ([x], pos) => {
      if ((x as Decimal).isNegative()) {
        throw new FormulaError(
          'invalid_result',
          'Wurzel aus einer negativen Zahl ist nicht möglich.',
          pos,
        )
      }
      return (x as Decimal).sqrt()
    },
  },
  abs: { arity: [1, 1], fn: ([x]) => (x as Decimal).abs() },
  round: {
    arity: [1, 2],
    fn: ([x, places]) => {
      const p = places ? places.toNumber() : 0
      if (!Number.isInteger(p) || p < 0 || p > 4) {
        throw new FormulaError('invalid_result', 'round(): Nachkommastellen müssen 0 bis 4 sein.')
      }
      return (x as Decimal).toDecimalPlaces(p, Decimal.ROUND_HALF_UP)
    },
  },
  ceil: { arity: [1, 1], fn: ([x]) => (x as Decimal).ceil() }, // aufrunden, z. B. auf ganze Gebinde
  floor: { arity: [1, 1], fn: ([x]) => (x as Decimal).floor() },
  min: { arity: [1, 50], fn: (args) => Decimal.min(...args) },
  max: { arity: [1, 50], fn: (args) => Decimal.max(...args) },
  pi: { arity: [0, 0], fn: () => CONSTANTS.pi as Decimal },
}

function lookupVariable(variables: Map<string, Decimal>, name: string, pos: number): Decimal {
  const value = variables.get(name.toLowerCase())
  if (value !== undefined) return value
  const constant = own(CONSTANTS, name.toLowerCase())
  if (constant) return constant
  throw new FormulaError(
    'unknown_variable',
    `Unbekannter Wert „${name}“. Bitte Raummaß anlegen oder Zahl eingeben.`,
    pos,
  )
}

function evaluateBinary(
  node: Extract<FormulaNode, { kind: 'binary' }>,
  variables: Map<string, Decimal>,
): Decimal {
  const left = evaluateNode(node.left, variables)
  const right = evaluateNode(node.right, variables)
  switch (node.op) {
    case '+':
      return left.plus(right)
    case '-':
      return left.minus(right)
    case '*':
      return left.mul(right)
    case '/':
      if (right.isZero()) {
        throw new FormulaError('division_by_zero', 'Division durch 0 ist nicht möglich.', node.pos)
      }
      return left.div(right)
    case '^':
      if (!right.isInteger() || right.abs().gt(10)) {
        throw new FormulaError(
          'invalid_result',
          'Hochzahlen sind nur als ganze Zahlen von -10 bis 10 erlaubt.',
          node.pos,
        )
      }
      if (left.isZero() && right.isNegative()) {
        throw new FormulaError('division_by_zero', 'Division durch 0 ist nicht möglich.', node.pos)
      }
      return left.pow(right)
  }
}

function evaluateNode(node: FormulaNode, variables: Map<string, Decimal>): Decimal {
  switch (node.kind) {
    case 'number':
      return new Decimal(node.value)
    case 'variable':
      return lookupVariable(variables, node.name, node.pos)
    case 'unary': {
      const value = evaluateNode(node.operand, variables)
      return node.op === '-' ? value.neg() : value
    }
    case 'binary':
      return evaluateBinary(node, variables)
    case 'call': {
      const impl = own(FUNCTIONS, node.name.toLowerCase())
      if (!impl)
        throw new FormulaError('unknown_function', `Unbekannte Funktion „${node.name}“.`, node.pos)
      const [minArgs, maxArgs] = impl.arity
      if (node.args.length < minArgs || node.args.length > maxArgs) {
        throw new FormulaError(
          'wrong_argument_count',
          `${node.name}() erwartet ${minArgs === maxArgs ? minArgs : `${minArgs} bis ${maxArgs}`} Wert(e).`,
          node.pos,
        )
      }
      return impl.fn(
        node.args.map((arg) => evaluateNode(arg, variables)),
        node.pos,
      )
    }
  }
}

function normalizeVariables(variables: FormulaVariables): Map<string, Decimal> {
  const map = new Map<string, Decimal>()
  for (const [name, value] of Object.entries(variables)) {
    map.set(name.toLowerCase(), toDecimal(value))
  }
  return map
}

/** Names of all variables a formula uses (lower case), e.g. to show missing room dimensions. */
export function formulaVariables(formula: string): string[] {
  const names = new Set<string>()
  const visit = (node: FormulaNode): void => {
    if (node.kind === 'variable' && !own(CONSTANTS, node.name.toLowerCase()))
      names.add(node.name.toLowerCase())
    if (node.kind === 'unary') visit(node.operand)
    if (node.kind === 'binary') {
      visit(node.left)
      visit(node.right)
    }
    if (node.kind === 'call') node.args.forEach(visit)
  }
  visit(parseFormula(formula))
  return [...names]
}

/** Evaluates a formula with full precision (no rounding). Throws FormulaError. */
export function evaluateFormulaExact(formula: string, variables: FormulaVariables = {}): Decimal {
  const result = evaluateNode(parseFormula(formula), normalizeVariables(variables))
  if (result.abs().gte('1e14')) {
    throw new FormulaError('invalid_result', 'Das Ergebnis ist zu groß. Bitte Eingabe prüfen.')
  }
  return result
}

/** Evaluates a formula and rounds to the stored precision (4 decimals) → "9.2711". */
export function evaluateFormula(formula: string, variables: FormulaVariables = {}): string {
  return roundQuantity(evaluateFormulaExact(formula, variables))
}

export type FormulaResult =
  | { ok: true; quantity: string }
  | { ok: false; error: { code: FormulaErrorCode; message: string; position?: number } }

/** Non-throwing variant for live preview while typing. */
export function tryEvaluateFormula(
  formula: string,
  variables: FormulaVariables = {},
): FormulaResult {
  try {
    return { ok: true, quantity: evaluateFormula(formula, variables) }
  } catch (error) {
    if (error instanceof FormulaError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.position === undefined ? {} : { position: error.position }),
        },
      }
    }
    if (error instanceof RangeError) {
      return {
        ok: false,
        error: { code: 'invalid_result', message: 'Ungültiger Wert in den Raummaßen.' },
      }
    }
    throw error
  }
}
