export type KpiCardProps = {
  readonly label: string
  readonly value: string | number
  readonly subtitle?: string
  readonly tone?: 'default' | 'success' | 'warning' | 'danger'
  readonly onClick?: () => void
}

export function KpiCard({ label, value, subtitle, tone = 'default', onClick }: KpiCardProps) {
  const cls = `v-kpi-card v-kpi-${tone}${onClick ? ' v-kpi-clickable' : ''}`
  const inner = (
    <>
      <span className="v-kpi-label">{label}</span>
      <strong className="v-kpi-value">{value}</strong>
      {subtitle && <span className="v-kpi-subtitle">{subtitle}</span>}
    </>
  )
  if (onClick) return <button type="button" className={cls} onClick={onClick}>{inner}</button>
  return <article className={cls}>{inner}</article>
}

type KpiRowProps = {
  readonly children: React.ReactNode
}

export function KpiRow({ children }: KpiRowProps) {
  return <div className="v-kpi-row">{children}</div>
}
