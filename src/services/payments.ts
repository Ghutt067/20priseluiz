import { postJson } from './http'

export function createChequePayment(input: {
  titleId?: string
  bank?: string
  agency?: string
  account?: string
  chequeNumber?: string
  dueDate?: string
  amount: number
}) {
  return postJson<{ id: string }>('/payments/cheques', input)
}

export function createCardPayment(input: {
  titleId?: string
  brand?: string
  holderName?: string
  last4?: string
  installments?: number
  amount: number
}) {
  return postJson<{ id: string }>('/payments/cards', input)
}
