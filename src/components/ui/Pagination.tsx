type PaginationProps = {
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly loading?: boolean
  readonly onPageChange: (newOffset: number) => void
}

export function Pagination({ total, offset, limit, loading, onPageChange }: PaginationProps) {
  const currentPage = Math.floor(offset / limit) + 1
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const hasPrev = offset > 0
  const hasNext = offset + limit < total

  return (
    <div className="v-pagination">
      <button
        type="button"
        className="v-pagination-btn"
        disabled={!hasPrev || loading}
        onClick={() => onPageChange(Math.max(0, offset - limit))}
      >
        ‹ Anterior
      </button>
      <span className="v-pagination-info">
        {total > 0 ? `${currentPage} de ${totalPages}` : 'Sem registros'}
      </span>
      <button
        type="button"
        className="v-pagination-btn"
        disabled={!hasNext || loading}
        onClick={() => onPageChange(offset + limit)}
      >
        Próximo ›
      </button>
    </div>
  )
}
