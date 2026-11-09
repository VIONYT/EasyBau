/** Data of the Typst letter template (templates/letter.typ). All texts are final strings. */
export interface LetterPdfInput {
  title: string
  author: string
  font: 'sans' | 'serif'
  accent: string
  foldMarks: boolean
  watermark: string | null
  logo: { path: string; x: number; y: number; width: number; maxHeight: number } | null
  texts: {
    x: number
    y: number
    width: number
    text: string
    fontSize: number
    bold: boolean
    align: 'left' | 'center' | 'right'
    color: string
  }[]
  senderLine: string
  recipient: string[]
  info: { label: string; value: string }[]
  footer: string[]
  body: {
    heading: string
    subject: string | null
    small: string[]
    intro: string | null
    columns: string[]
    items: (
      | { kind: 'title'; oz: string; text: string; total: string }
      | { kind: 'text'; text: string }
      | {
          kind: 'item'
          oz: string
          text: string
          note: string | null
          longText: string | null
          quantity: string
          unitPrice: string
          total: string
        }
    )[]
    deductions: {
      title: string
      columns: string[]
      rows: { label: string; net: string; tax: string; gross: string }[]
      rest: { label: string; net: string; tax: string; gross: string }
    } | null
    totals: { label: string; value: string; grand: boolean; note: string | null }[]
    notes: string[]
    closing: string | null
  }
}
