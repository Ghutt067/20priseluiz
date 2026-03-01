import { useState, useCallback, type ChangeEvent, type FocusEvent, type InputHTMLAttributes } from 'react'

type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'> & {
  value: string
  onChange: (event: { target: { value: string } }) => void
}

function isoToDisplay(iso: string): string {
  if (!iso) return ''
  const parts = iso.split('-')
  if (parts.length !== 3) return ''
  return `${parts[2]}/${parts[1]}/${parts[0]}`
}

function displayToIso(display: string): string {
  const digits = display.replaceAll(/\D/g, '')
  if (digits.length !== 8) return ''
  const dd = digits.slice(0, 2)
  const mm = digits.slice(2, 4)
  const yyyy = digits.slice(4, 8)
  return `${yyyy}-${mm}-${dd}`
}

function applyMask(raw: string): string {
  const digits = raw.replaceAll(/\D/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}

export function DateInput({ value, onChange, placeholder, onBlur, ...rest }: DateInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const displayValue = draft ?? isoToDisplay(value)

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const masked = applyMask(event.target.value)
      setDraft(masked)
      const iso = displayToIso(masked)
      if (iso) {
        onChange({ target: { value: iso } })
      }
    },
    [onChange],
  )

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      setDraft(null)
      onBlur?.(event)
    },
    [onBlur],
  )

  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      placeholder={placeholder ?? 'DD/MM/AAAA'}
      value={displayValue}
      onChange={handleChange}
      onBlur={handleBlur}
    />
  )
}
