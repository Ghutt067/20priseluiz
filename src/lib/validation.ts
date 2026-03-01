/**
 * Validates a Brazilian CPF number (11 digits).
 */
export function isValidCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, '')
  if (digits.length !== 11) return false
  if (/^(\d)\1{10}$/.test(digits)) return false

  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i)
  let remainder = (sum * 10) % 11
  if (remainder === 10) remainder = 0
  if (remainder !== Number(digits[9])) return false

  sum = 0
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * (11 - i)
  remainder = (sum * 10) % 11
  if (remainder === 10) remainder = 0
  return remainder === Number(digits[10])
}

/**
 * Validates a Brazilian CNPJ number (14 digits).
 */
export function isValidCnpj(cnpj: string): boolean {
  const digits = cnpj.replace(/\D/g, '')
  if (digits.length !== 14) return false
  if (/^(\d)\1{13}$/.test(digits)) return false

  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * weights1[i]
  let remainder = sum % 11
  const check1 = remainder < 2 ? 0 : 11 - remainder
  if (check1 !== Number(digits[12])) return false

  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  sum = 0
  for (let i = 0; i < 13; i++) sum += Number(digits[i]) * weights2[i]
  remainder = sum % 11
  const check2 = remainder < 2 ? 0 : 11 - remainder
  return check2 === Number(digits[13])
}

/**
 * Validates CPF or CNPJ based on length.
 */
export function isValidCpfCnpj(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (digits.length === 11) return isValidCpf(value)
  if (digits.length === 14) return isValidCnpj(value)
  return false
}

/**
 * Formats CPF: 000.000.000-00
 */
export function formatCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, '').slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
}

/**
 * Formats CNPJ: 00.000.000/0000-00
 */
export function formatCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, '').slice(0, 14)
  if (d.length <= 2) return d
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}

/**
 * Auto-formats CPF or CNPJ based on length.
 */
export function formatCpfCnpj(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length <= 11) return formatCpf(value)
  return formatCnpj(value)
}

/**
 * Formats phone: (00) 0000-0000 or (00) 00000-0000
 */
export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '').slice(0, 11)
  if (d.length <= 2) return d.length > 0 ? `(${d}` : d
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
}

/**
 * Simple email validation.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/**
 * Generic form validation result.
 */
export type FieldErrors = Record<string, string>

export function validateRequired(value: string, fieldName: string): string | null {
  return value.trim() ? null : `${fieldName} é obrigatório.`
}

export function validateCpfCnpj(value: string): string | null {
  if (!value.trim()) return null
  const digits = value.replace(/\D/g, '')
  if (digits.length === 0) return null
  if (digits.length !== 11 && digits.length !== 14) return 'CPF deve ter 11 dígitos ou CNPJ 14 dígitos.'
  if (!isValidCpfCnpj(value)) return digits.length === 11 ? 'CPF inválido.' : 'CNPJ inválido.'
  return null
}

export function validateEmail(value: string): string | null {
  if (!value.trim()) return null
  return isValidEmail(value) ? null : 'E-mail inválido.'
}

export function validatePhone(value: string): string | null {
  if (!value.trim()) return null
  const digits = value.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 11) return 'Telefone deve ter 10 ou 11 dígitos.'
  return null
}
