import { useState } from 'react'

type StatusTransition = {
  value: string
  label: string
}

type StatusSelectProps = {
  readonly current: string
  readonly transitions: readonly StatusTransition[]
  readonly onConfirm: (newStatus: string) => void | Promise<void>
  readonly disabled?: boolean
  readonly confirmMessage?: string
}

export function StatusSelect({
  current,
  transitions,
  onConfirm,
  disabled = false,
  confirmMessage,
}: StatusSelectProps) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (transitions.length === 0) return null

  const handleChange = (value: string) => {
    if (!value || value === current) return
    if (confirmMessage) {
      setConfirming(value)
    } else {
      void execute(value)
    }
  }

  const execute = async (value: string) => {
    setBusy(true)
    try {
      await onConfirm(value)
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  return (
    <>
      <select
        value=""
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled || busy}
        style={{ fontSize: 12 }}
      >
        <option value="" disabled>
          Mudar status
        </option>
        {transitions.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      {confirming && (
        <div className="v-confirm-overlay">
          <div className="v-confirm-dialog">
            <p>{confirmMessage ?? `Alterar status para "${confirming}"?`}</p>
            <div className="v-confirm-actions">
              <button type="button" onClick={() => setConfirming(null)} disabled={busy}>
                Cancelar
              </button>
              <button type="button" onClick={() => void execute(confirming)} disabled={busy}>
                {busy ? 'Processando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
