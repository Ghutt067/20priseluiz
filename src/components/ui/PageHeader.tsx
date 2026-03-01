import { type ReactNode } from 'react'

type PageHeaderProps = {
  readonly title?: string
  readonly subtitle?: string
  readonly actions?: ReactNode
}

export function PageHeader({ actions }: PageHeaderProps) {
  if (!actions) return null

  return (
    <div className="v-page-header">
      <div className="v-page-header-actions">{actions}</div>
    </div>
  )
}
