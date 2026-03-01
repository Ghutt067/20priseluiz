import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react'

export type SelectOption = {
  value: string
  label: string
}

type SelectProps = {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
  style?: CSSProperties
  disabled?: boolean
}

export function Select({ value, options, onChange, className, style, disabled = false }: SelectProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedLabel = options.find((o) => o.value === value)?.label ?? ''

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, close])

  const handleSelect = (optionValue: string) => {
    onChange(optionValue)
    close()
  }

  const wrapperClass = [
    'custom-select',
    open ? 'open' : '',
    disabled ? 'disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={containerRef} className={wrapperClass} style={style}>
      <button
        type="button"
        className="custom-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{selectedLabel}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor" aria-hidden="true">
          <path d="M0 0l5 6 5-6z" />
        </svg>
      </button>
      {open && (
        <div className="custom-select-menu" role="listbox">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={[
                'custom-select-option',
                opt.value === value ? 'selected' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => handleSelect(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
