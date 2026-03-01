import { type ReactNode } from 'react'

type DetailPanelProps = {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly subtitle?: string
  readonly children: ReactNode
  readonly actions?: ReactNode
}

export function DetailPanel({ open, onClose, title, subtitle, children, actions }: DetailPanelProps) {
  if (!open) return null
  return (
    <div className="v-detail-panel">
      <div className="v-detail-header">
        <div>
          <h3 className="v-detail-title">{title}</h3>
          {subtitle && <p className="v-detail-subtitle">{subtitle}</p>}
        </div>
        <div className="v-detail-header-actions">
          {actions}
          <button type="button" className="v-detail-close" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
      </div>
      <div className="v-detail-body">{children}</div>
    </div>
  )
}

type DetailFieldProps = {
  readonly label: string
  readonly value: ReactNode
}

export function DetailField({ label, value }: DetailFieldProps) {
  return (
    <div className="v-detail-field">
      <span className="v-detail-field-label">{label}</span>
      <span className="v-detail-field-value">{value ?? '—'}</span>
    </div>
  )
}

type DetailGridProps = {
  readonly children: ReactNode
  readonly columns?: 2 | 3 | 4
}

export function DetailGrid({ children, columns = 3 }: DetailGridProps) {
  return (
    <div className="v-detail-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {children}
    </div>
  )
}
