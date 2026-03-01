import { getJson, postJson, patchJson } from './http'

export type TreasuryLoan = {
  id: string; loanType: string; bankName: string | null
  principalAmount: number; interestRate: number; amortizationSystem: string
  totalInstallments: number; startDate: string; status: string
  notes: string | null; createdAt: string
}

export type LoanInstallment = {
  id: string; installmentNumber: number; amortization: number; interest: number
  totalAmount: number; outstandingBalance: number; dueDate: string
  paidAt: string | null; status: string
}

export type IntercompanyTransfer = {
  id: string; sourceOrgId: string; targetOrgId: string
  sourceOrgName: string; targetOrgName: string
  transferType: string; amount: number; description: string | null
  status: string; createdAt: string
}

export function fetchLoans(status?: string) {
  const q = status ? `?status=${status}` : ''
  return getJson<TreasuryLoan[]>(`/treasury/loans${q}`)
}

export function createLoan(input: {
  loanType: string; bankName?: string; principalAmount: number
  interestRate: number; amortizationSystem?: string
  totalInstallments: number; startDate: string; notes?: string
}) {
  return postJson<{ id: string; installmentsGenerated: number }>('/treasury/loans', input)
}

export function fetchLoanInstallments(loanId: string) {
  return getJson<LoanInstallment[]>(`/treasury/loans/${loanId}/installments`)
}

export function fetchIntercompany() {
  return getJson<IntercompanyTransfer[]>('/treasury/intercompany')
}

export function createIntercompanyTransfer(input: {
  targetOrganizationId: string; transferType: string; amount: number; description?: string
}) {
  return postJson<{ id: string }>('/treasury/intercompany', input)
}

export function updateLoanStatus(id: string, status: string) {
  return patchJson<{ id: string }>(`/treasury/loans/${id}`, { status })
}

export function payLoanInstallment(id: string) {
  return patchJson<{ paid: boolean }>(`/treasury/loans/installments/${id}/pay`, {})
}

export function updateIntercompanyStatus(id: string, status: string) {
  return patchJson<{ id: string }>(`/treasury/intercompany/${id}`, { status })
}
