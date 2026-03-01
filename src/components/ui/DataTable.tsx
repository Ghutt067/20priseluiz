import { type ReactNode } from 'react'

export type Column<T> = {
  key: string
  header: string
  width?: string
  align?: 'left' | 'center' | 'right'
  render: (row: T, index: number) => ReactNode
}

type DataTableProps<T> = {
  readonly columns: Column<T>[]
  readonly rows: T[]
  readonly rowKey: (row: T) => string
  readonly loading?: boolean
  readonly emptyMessage?: string
  readonly onRowClick?: (row: T) => void
  readonly compact?: boolean
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  emptyMessage = 'Nenhum registro encontrado.',
  onRowClick,
  compact,
}: DataTableProps<T>) {
  return (
    <div className={`v-table-wrap${compact ? ' v-table-compact' : ''}`}>
      <table className="v-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{ width: col.width, textAlign: col.align ?? 'left' }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={loading ? 'loading-fade' : ''}>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="v-table-empty">
                {emptyMessage}
              </td>
            </tr>
          )}
          {rows.map((row, index) => (
              <tr
                key={rowKey(row)}
                className={onRowClick ? 'v-table-clickable' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} style={{ textAlign: col.align ?? 'left' }}>
                    {col.render(row, index)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}
