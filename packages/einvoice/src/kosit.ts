/** Result of the KoSIT validator (VARL report), reduced to what the app shows and stores. */
export interface ValidationMessage {
  level: 'error' | 'warning' | 'information'
  /** Rule id, e.g. BR-DE-15 or cvc-complex-type.2.4.b */
  code: string | null
  text: string
}

export interface ValidationResult {
  /** Accepted by the validator (HTTP 200 / rep:accept). */
  valid: boolean
  /** Matched scenario, e.g. "EN16931 XRechnung (UBL Invoice)". */
  scenario: string | null
  /** Validator engine, e.g. "KoSIT Validator 1.6.3". */
  engine: string | null
  messages: ValidationMessage[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10))
    return ENTITIES[e] as string
  })
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return match ? unescapeXml(match[1] as string) : null
}

/** Reads the KoSIT VARL report (regular expressions only, the report is never evaluated). */
export function parseKositReport(report: string): ValidationResult {
  const messages: ValidationMessage[] = []
  for (const match of report.matchAll(/<rep:message\b([^>]*)>([\s\S]*?)<\/rep:message>/g)) {
    const attrs = match[1] as string
    const level = attribute(attrs, 'level')
    messages.push({
      level: level === 'error' || level === 'warning' ? level : 'information',
      code: attribute(attrs, 'code'),
      text: unescapeXml((match[2] as string).replace(/<[^>]+>/g, '').trim()).replace(/\s+/g, ' '),
    })
  }
  const scenarioBlock = /<rep:scenarioMatched>([\s\S]*?)<\/s:name>/.exec(report)?.[1]
  const scenario = scenarioBlock
    ? unescapeXml(scenarioBlock.replace(/[\s\S]*<s:name>/, '').trim())
    : null
  const engine = /<rep:engine>\s*<rep:name>([^<]*)<\/rep:name>/.exec(report)?.[1] ?? null
  const valid = /<rep:assessment>\s*<rep:accept\b/.test(report)
  return { valid, scenario, engine: engine ? unescapeXml(engine) : null, messages }
}
