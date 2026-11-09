import { type CsvValue, csvLine } from './csv.js'

/**
 * GoBD-Datenträgerüberlassung (Z3) in the Beschreibungsstandard of the tax authorities:
 * CSV files without header plus index.xml (gdpdu-01-09-2004.dtd) describing them.
 */

export interface GobdColumn {
  name: string
  type: 'text' | 'numeric' | 'date'
  /** Decimal places for numeric columns. */
  accuracy?: number
  primaryKey?: boolean
}

export interface GobdTable {
  file: string
  name: string
  description: string
  columns: GobdColumn[]
  rows: CsvValue[][]
}

export interface GobdSupplier {
  name: string
  location: string
  comment: string
}

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function column(c: GobdColumn): string {
  const type =
    c.type === 'numeric'
      ? `<Numeric>${c.accuracy ? `<Accuracy>${c.accuracy}</Accuracy>` : ''}</Numeric>`
      : c.type === 'date'
        ? '<Date><Format>DD.MM.YYYY</Format></Date>'
        : '<AlphaNumeric/>'
  const tag = c.primaryKey ? 'VariablePrimaryKey' : 'VariableColumn'
  return `        <${tag}><Name>${xml(c.name)}</Name>${type}</${tag}>`
}

export function gobdIndexXml(
  supplier: GobdSupplier,
  period: { from: string; to: string },
  tables: readonly GobdTable[],
): string {
  const date = (iso: string) => iso.split('-').reverse().join('.')
  const body = tables
    .map((table) => {
      // Primary keys must come first (DTD order).
      const columns = [
        ...table.columns.filter((c) => c.primaryKey),
        ...table.columns.filter((c) => !c.primaryKey),
      ]
      return [
        '    <Table>',
        `      <URL>${xml(table.file)}</URL>`,
        `      <Name>${xml(table.name)}</Name>`,
        `      <Description>${xml(table.description)}</Description>`,
        '      <Validity>',
        `        <Range><From>${date(period.from)}</From><To>${date(period.to)}</To></Range>`,
        '        <Format>DD.MM.YYYY</Format>',
        '      </Validity>',
        '      <UTF8/>',
        '      <DecimalSymbol>,</DecimalSymbol>',
        '      <DigitGroupingSymbol>.</DigitGroupingSymbol>',
        '      <VariableLength>',
        '        <ColumnDelimiter>;</ColumnDelimiter>',
        '        <RecordDelimiter>&#13;&#10;</RecordDelimiter>',
        '        <TextEncapsulator>"</TextEncapsulator>',
        ...columns.map(column),
        '      </VariableLength>',
        '    </Table>',
      ].join('\n')
    })
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">',
    '<DataSet>',
    '  <Version>1.0</Version>',
    '  <DataSupplier>',
    `    <Name>${xml(supplier.name)}</Name>`,
    `    <Location>${xml(supplier.location)}</Location>`,
    `    <Comment>${xml(supplier.comment)}</Comment>`,
    '  </DataSupplier>',
    '  <Media>',
    '    <Name>Datenträger 1</Name>',
    body,
    '  </Media>',
    '</DataSet>',
    '',
  ].join('\n')
}

/** Data file of a table: no header line, columns in the order of the description. */
export function gobdTableCsv(table: GobdTable): string {
  const order = [
    ...table.columns.filter((c) => c.primaryKey),
    ...table.columns.filter((c) => !c.primaryKey),
  ].map((c) => table.columns.indexOf(c))
  return table.rows
    .map(
      (row) =>
        `${csvLine(
          order.map((i) => row[i]),
          true,
        )}\r\n`,
    )
    .join('')
}
