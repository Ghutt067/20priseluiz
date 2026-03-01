import { type ReactNode } from 'react'

type FormFieldProps = {
  readonly label: string
  readonly error?: string | null
  readonly required?: boolean
  readonly children: ReactNode
  readonly hint?: string
}

export function FormField({ label, error, required, children, hint }: FormFieldProps) {
  return (
    <label className={`v-field${error ? ' v-field-error' : ''}`}>
      <span className="v-field-label">
        {label}
        {required && <span className="v-field-required">*</span>}
      </span>
      {children}
      {error && <span className="v-field-msg v-field-msg-error">{error}</span>}
      {!error && hint && <span className="v-field-msg v-field-msg-hint">{hint}</span>}
    </label>
  )
}
