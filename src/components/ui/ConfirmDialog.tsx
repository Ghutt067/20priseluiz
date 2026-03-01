import { Modal } from './Modal'

type ConfirmDialogProps = {
  readonly open: boolean
  readonly onClose: () => void
  readonly onConfirm: () => void
  readonly title?: string
  readonly message: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly variant?: 'danger' | 'warning' | 'default'
  readonly loading?: boolean
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Confirmar ação',
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  variant = 'default',
  loading,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <div className="v-confirm-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={variant === 'danger' ? 'v-btn-danger' : ''}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'Aguarde...' : confirmLabel}
          </button>
        </div>
      }
    >
      <p className="v-confirm-message">{message}</p>
    </Modal>
  )
}
