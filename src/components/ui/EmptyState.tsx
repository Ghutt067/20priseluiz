import { type ReactNode } from 'react'

type EmptyStateProps = {
  readonly icon?: string // Kept for prop compat, but not rendered
  readonly title: string
  readonly description?: string // Kept for prop compat, but not rendered
  readonly action?: ReactNode
}

export function EmptyState({ title, action }: EmptyStateProps) {
  return (
    <div className="v-empty">
      <p className="v-empty-title">{title}</p>
      {action && <div className="v-empty-action">{action}</div>}
    </div>
  )
}
