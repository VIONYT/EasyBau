import { parseKositReport, type ValidationResult } from '@easybau/einvoice'

/** Validation of one e-invoice XML (rule 8). */
export interface EinvoiceValidation {
  valid: boolean
  /** Full VARL report as returned by KoSIT; archived with the XML. */
  report: string
  result: ValidationResult
}

export interface EinvoiceValidator {
  validate(xml: string): Promise<EinvoiceValidation>
}

/** KoSIT could not be reached or answered unexpectedly; the invoice is not finalized. */
export class ValidatorUnavailableError extends Error {
  override name = 'ValidatorUnavailableError'
}

/**
 * Client for the KoSIT validator daemon (ADR 0007): POST the XML to / → 200 accepted, 406 rejected;
 * the body is the validation report.
 */
export function kositValidator(url: string, timeoutMs: number): EinvoiceValidator {
  const endpoint = `${url.replace(/\/+$/, '')}/`
  return {
    async validate(xml) {
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/xml' },
          body: xml,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw new ValidatorUnavailableError(`KoSIT not reachable: ${(error as Error).message}`)
      }
      if (response.status !== 200 && response.status !== 406) {
        await response.body?.cancel()
        throw new ValidatorUnavailableError(`KoSIT answered HTTP ${response.status}`)
      }
      const report = await response.text()
      const result = parseKositReport(report)
      return { valid: response.status === 200 && result.valid, report, result }
    },
  }
}

/** Is the validator up? (Betriebs-Check) */
export async function kositHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/server/health`, {
      signal: AbortSignal.timeout(3000),
    })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}
