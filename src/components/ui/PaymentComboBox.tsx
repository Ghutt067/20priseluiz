import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence'

const PAYMENT_OPTIONS = [
  'PIX',
  'Dinheiro',
  'Cartão de Crédito',
  'Cartão de Débito',
  'Boleto',
  'Transferência Bancária',
  'À vista',
  '30 dias',
  '30/60',
  '30/60/90',
  '30/60/90/120',
  'Cheque',
  'Crediário',
]

type PaymentComboBoxProps = {
  value: string
  onChange: (value: string) => void
  style?: React.CSSProperties
}

export function PaymentComboBox({ value, onChange, style }: PaymentComboBoxProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(-1)
  const [overflows, setOverflows] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const displayRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  const showDropdown = open && (query
    ? PAYMENT_OPTIONS.some((o) => o.toLowerCase().includes(query.toLowerCase()))
    : true)
  const { mounted: menuMounted, exiting: menuExiting } = useAnimatedPresence(showDropdown, 180)

  const filtered = (open || menuMounted)
    ? (query
        ? PAYMENT_OPTIONS.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
        : PAYMENT_OPTIONS)
    : []

  useEffect(() => {
    setFocusIndex(-1)
  }, [query])

  useLayoutEffect(() => {
    if (!open && displayRef.current && textRef.current) {
      const overflow = textRef.current.scrollWidth - displayRef.current.clientWidth
      setOverflows(overflow > 0)
      if (overflow > 0) {
        textRef.current.style.setProperty('--overflow-px', `${overflow}px`)
      }
    }
  }, [value, open])

  const select = (val: string) => {
    onChange(val)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  const handleFocus = () => {
    setQuery('')
    setOpen(true)
  }

  const handleBlur = (e: React.FocusEvent) => {
    if (wrapperRef.current?.contains(e.relatedTarget as Node)) return
    setQuery('')
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (focusIndex >= 0 && focusIndex < filtered.length) {
        select(filtered[focusIndex])
      } else if (filtered.length > 0) {
        select(filtered[0])
      }
    } else if (e.key === 'Escape') {
      setQuery('')
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  return (
    <div
      ref={wrapperRef}
      className="payment-combobox"
      onBlur={handleBlur}
      style={style}
    >
      <input
        ref={inputRef}
        value={open ? query : value}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        placeholder="Condição de pagamento"
        className={open ? '' : 'payment-combobox-hidden-text'}
      />
      {!open && value && (
        <div
          ref={displayRef}
          className="payment-combobox-display"
          onClick={() => inputRef.current?.focus()}
        >
          <span ref={textRef} className={overflows ? 'payment-marquee' : ''}>
            {value}
          </span>
        </div>
      )}
      {menuMounted && filtered.length > 0 && (
        <div className={`payment-combobox-dropdown ${menuExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
          {filtered.map((option, i) => (
            <button
              key={option}
              type="button"
              className={`payment-combobox-option${i === focusIndex ? ' focused' : ''}${option === value ? ' selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
