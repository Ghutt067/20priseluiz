import { useCallback, type ChangeEvent, type FocusEvent, type InputHTMLAttributes } from 'react'

type NumericInputProps = Readonly<Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'> & {
  value: string | number
  onChange: (event: { target: { value: string } }) => void
  decimals?: number
  currency?: boolean
}>

type CurrencyInputProps = Readonly<Omit<NumericInputProps, 'decimals' | 'currency'>>

function normalizeIntegerPart(rawInteger: string) {
  const normalized = rawInteger.replace(/^0+(\d)/, '$1')
  return normalized === '' ? '0' : normalized
}

function splitDecimalParts(cleaned: string) {
  const lastDot = cleaned.lastIndexOf('.')
  const lastComma = cleaned.lastIndexOf(',')

  if (lastComma > lastDot && lastComma >= 0) {
    return [
      cleaned.slice(0, lastComma).replaceAll(/[.,]/g, ''),
      cleaned.slice(lastComma + 1).replaceAll(/[.,]/g, ''),
    ] as const
  }

  if (lastDot >= 0) {
    return [
      cleaned.slice(0, lastDot).replaceAll(/[.,]/g, ''),
      cleaned.slice(lastDot + 1).replaceAll(/[.,]/g, ''),
    ] as const
  }

  return [cleaned.replaceAll(/[.,]/g, ''), undefined] as const
}

function withOptionalNegative(value: string, negative: boolean) {
  return negative ? `-${value}` : value
}

function sanitize(raw: string, maxDecimals?: number): string {
  let cleaned = raw.replaceAll(/[^\d.,-]/g, '')

  const hasNegative = cleaned.startsWith('-')
  cleaned = cleaned.replaceAll('-', '')

  if (maxDecimals === 0) {
    cleaned = cleaned.replaceAll(/[.,]/g, '')
    return withOptionalNegative(normalizeIntegerPart(cleaned), hasNegative)
  }

  const [rawInteger, rawDecimal] = splitDecimalParts(cleaned)
  const integer = normalizeIntegerPart(rawInteger)
  let decimal = rawDecimal
  if (decimal !== undefined && maxDecimals !== undefined) {
    decimal = decimal.slice(0, maxDecimals)
  }

  if (decimal === undefined) {
    return withOptionalNegative(integer, hasNegative)
  }

  return withOptionalNegative(`${integer}.${decimal}`, hasNegative)
}

function centavosToDisplay(centavos: number): string {
  const negative = centavos < 0
  const abs = Math.abs(centavos)
  const intPart = Math.floor(abs / 100)
  const decPart = abs % 100
  const formatted = `${intPart},${String(decPart).padStart(2, '0')}`
  return negative ? `-${formatted}` : formatted
}

function valueToCentavos(v: string | number): number {
  const num = typeof v === 'number' ? v : Number(v)
  if (Number.isNaN(num)) return 0
  return Math.round(num * 100)
}

function CurrencyInput({ value, onChange, placeholder, ...rest }: CurrencyInputProps) {
  const centavos = valueToCentavos(value)
  const display = centavosToDisplay(centavos)
  const { onFocus, ...inputProps } = rest

  const handleFocus = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      event.target.select()
      onFocus?.(event)
    },
    [onFocus],
  )

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const digits = event.target.value.replaceAll(/\D/g, '')
      const newCentavos = digits === '' ? 0 : Number.parseInt(digits, 10)
      const numeric = (newCentavos / 100).toFixed(2)
      onChange({ target: { value: numeric } })
    },
    [onChange],
  )

  return (
    <input
      {...inputProps}
      type="text"
      inputMode="numeric"
      placeholder={placeholder ?? '0,00'}
      value={display}
      onFocus={handleFocus}
      onChange={handleChange}
    />
  )
}

export function NumericInput({ value, onChange, decimals, currency, placeholder, ...rest }: NumericInputProps) {
  const displayValue = String(value)
  const { onFocus, ...inputProps } = rest

  const handleFocus = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      event.target.select()
      onFocus?.(event)
    },
    [onFocus],
  )

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value
      if (raw === '' || raw === '-') {
        onChange({ target: { value: raw } })
        return
      }
      const sanitized = sanitize(raw, decimals)
      onChange({ target: { value: sanitized } })
    },
    [onChange, decimals],
  )

  if (currency) {
    return <CurrencyInput value={value} onChange={onChange} placeholder={placeholder} {...rest} />
  }

  return (
    <input
      {...inputProps}
      type="text"
      inputMode={decimals === 0 ? 'numeric' : 'decimal'}
      placeholder={placeholder ?? '0'}
      value={displayValue}
      onFocus={handleFocus}
      onChange={handleChange}
    />
  )
}
