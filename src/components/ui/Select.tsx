import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react'
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence'

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
  const { mounted: menuMounted, exiting: menuExiting } = useAnimatedPresence(open, 180)

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
        <svg width="10" height="10" viewBox="0 0 32 32" style={{ transform: 'rotate(180deg)' }} fill="#2B2B2B" aria-hidden="true">
          <path d="M29.9,28.6l-13-26c-0.3-0.7-1.4-0.7-1.8,0l-13,26c-0.2,0.4-0.1,0.8,0.2,1.1C2.5,30,3,30.1,3.4,29.9L16,25.1l12.6,4.9c0.1,0,0.2,0.1,0.4,0.1c0.3,0,0.5-0.1,0.7-0.3C30,29.4,30.1,28.9,29.9,28.6z"/>
        </svg>
      </button>
      {menuMounted && (
        <div className={`custom-select-menu ${menuExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`} role="listbox">
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
