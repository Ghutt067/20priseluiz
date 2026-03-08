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

function clampSegment(segment: string, max: number): string {
  if (segment.length === 0) return segment
  const num = Number.parseInt(segment, 10)
  if (Number.isNaN(num)) return segment
  if (segment.length === 1) {
    if (num > Math.floor(max / 10)) return String(max).slice(0, 1)
    return segment
  }
  if (num > max) return String(max)
  if (num === 0) return '01'
  return segment
}

function applyMask(raw: string): string {
  const digits = raw.replaceAll(/\D/g, '').slice(0, 8)
  if (digits.length === 0) return ''
  let dd = digits.slice(0, 2)
  dd = clampSegment(dd, 31)
  if (digits.length <= 2) return dd
  let mm = digits.slice(2, 4)
  mm = clampSegment(mm, 12)
  if (digits.length <= 4) return `${dd}/${mm}`
  const yyyy = digits.slice(4, 8)
  return `${dd}/${mm}/${yyyy}`
}

export function DateInput({ value, onChange, placeholder, onBlur, ...rest }: DateInputProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const displayValue = draft ?? isoToDisplay(value)

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const masked = applyMask(event.target.value)
      setDraft(masked)
      if (masked === '') {
        onChange({ target: { value: '' } })
        return
      }
      const iso = displayToIso(masked)
      if (iso) {
        onChange({ target: { value: iso } })
      }
    },
    [onChange],
  )

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      if (draft !== null) {
        const digits = draft.replaceAll(/\D/g, '')
        if (digits.length === 0) {
          onChange({ target: { value: '' } })
        } else if (digits.length < 8) {
          // incomplete date — clear it
          onChange({ target: { value: '' } })
        }
      }
      setDraft(null)
      onBlur?.(event)
    },
    [draft, onChange, onBlur],
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
