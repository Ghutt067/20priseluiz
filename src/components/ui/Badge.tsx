type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'default'

type BadgeProps = {
  readonly children: React.ReactNode
  readonly variant?: BadgeVariant
  readonly size?: 'sm' | 'md'
}

const variantClass: Record<BadgeVariant, string> = {
  success: 'badge-ok',
  warning: 'badge-warn',
  danger: 'badge-off',
  info: 'badge-info',
  muted: 'badge-muted',
  default: '',
}

export function Badge({ children, variant = 'default', size = 'sm' }: BadgeProps) {
  const cls = `status-badge ${variantClass[variant]}${size === 'md' ? ' badge-md' : ''}`
  return <span className={cls}>{children}</span>
}

const statusVariantMap: Record<string, BadgeVariant> = {
  active: 'success',
  open: 'info',
  paid: 'success',
  completed: 'success',
  authorized: 'success',
  delivered: 'success',
  received: 'info',
  processed: 'success',
  generated: 'success',
  sent: 'success',
  pending: 'warning',
  draft: 'muted',
  scheduled: 'info',
  in_progress: 'info',
  dispatched: 'info',
  queued: 'info',
  overdue: 'danger',
  inactive: 'muted',
  cancelled: 'muted',
  canceled: 'muted',
  denied: 'danger',
  error: 'danger',
  rejected: 'danger',
  failed: 'danger',
  returned: 'success',
  bounced: 'danger',
  closed: 'muted',
  expired: 'muted',
  paused: 'warning',
  approved: 'info',
  requested: 'warning',
  refunded: 'success',
  ended: 'muted',
}

const statusLabelMap: Record<string, string> = {
  active: 'Ativo',
  inactive: 'Inativo',
  open: 'Aberto',
  closed: 'Fechado',
  paid: 'Pago',
  pending: 'Pendente',
  canceled: 'Cancelado',
  cancelled: 'Cancelado',
  overdue: 'Vencido',
  draft: 'Rascunho',
  approved: 'Aprovado',
  received: 'Recebido',
  completed: 'Concluído',
  in_progress: 'Em andamento',
  scheduled: 'Agendado',
  dispatched: 'Despachado',
  delivered: 'Entregue',
  authorized: 'Autorizado',
  denied: 'Negado',
  error: 'Erro',
  rejected: 'Rejeitado',
  generated: 'Gerado',
  sent: 'Enviado',
  processed: 'Processado',
  failed: 'Falhou',
  queued: 'Na fila',
  returned: 'Devolvido',
  bounced: 'Devolvido',
  expired: 'Expirado',
  paused: 'Pausado',
  requested: 'Solicitado',
  refunded: 'Reembolsado',
  ended: 'Encerrado',
}

export function StatusBadge({ status, label }: { readonly status: string; readonly label?: string }) {
  const variant = statusVariantMap[status] ?? 'muted'
  const text = label ?? statusLabelMap[status] ?? status
  return <Badge variant={variant}>{text}</Badge>
}
