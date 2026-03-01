import { type ReactNode } from 'react'

type SearchToolbarProps = {
  readonly query: string
  readonly onQueryChange: (value: string) => void
  readonly placeholder?: string
  readonly actions?: ReactNode
  readonly count?: number
  readonly countLabel?: string
}

export function SearchToolbar({
  query,
  onQueryChange,
  placeholder = 'Buscar...',
  actions,
  count,
  countLabel,
}: SearchToolbarProps) {
  return (
    <div className="v-search-toolbar">
      <div className="v-search-toolbar-left">
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          className="v-search-input"
        />
        {count !== undefined && (
          <span className="v-search-count">
            {count} {countLabel ?? 'registro(s)'}
          </span>
        )}
      </div>
      {actions && <div className="v-search-toolbar-actions">{actions}</div>}
    </div>
  )
}
