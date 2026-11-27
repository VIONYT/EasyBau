import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: string
  cell: (row: T) => ReactNode
  /** Amounts and quantities: right-aligned with tabular figures. */
  numeric?: boolean
  /** The cell names its row (rendered as <th scope="row">, e.g. the changed field). */
  rowHeader?: boolean
}

/**
 * Tabelle mit festem Kopf (DESIGN.md §7.2): the header stays visible while scrolling, the table
 * scrolls sideways inside its own box on narrow screens (no horizontal page scroll).
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  maxHeight,
}: {
  caption: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode
  /** Height of the scroll box, e.g. "60vh"; without it the page scrolls. */
  maxHeight?: string
}) {
  if (!rows.length && empty) return <>{empty}</>
  return (
    <div className="data-table" style={maxHeight ? { maxHeight } : undefined}>
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.numeric ? 'numeric' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) =>
                c.rowHeader ? (
                  <th key={c.key} scope="row" className={c.numeric ? 'numeric' : undefined}>
                    {c.cell(row)}
                  </th>
                ) : (
                  <td key={c.key} className={c.numeric ? 'numeric' : undefined}>
                    {c.cell(row)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
