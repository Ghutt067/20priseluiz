import { useEffect, useRef, type ReactNode } from 'react'

type ModalProps = {
  readonly open: boolean
  readonly onClose: () => void
  readonly title?: string
  readonly children: ReactNode
  readonly size?: 'sm' | 'md' | 'lg'
  readonly footer?: ReactNode
}

export function Modal({ open, onClose, title, children, size = 'md', footer }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  return (
    <div
      ref={overlayRef}
      className="v-modal-overlay"
      style={{ display: open ? undefined : 'none' }}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div className={`v-modal v-modal-${size}`} role="dialog" aria-modal="true">
        {title && (
          <div className="v-modal-header">
            <h2 className="v-modal-title">{title}</h2>
            <button type="button" className="v-modal-close" onClick={onClose} aria-label="Fechar">
              ✕
            </button>
          </div>
        )}
        <div className="v-modal-body">{children}</div>
        {footer && <div className="v-modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
