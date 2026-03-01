import { getJson, patchJson, postJson, putJson } from './http'

export type EmployeeLookup = {
  id: string; name: string; role: string | null; email: string | null
  phone: string | null; status: string; createdAt: string
}
export type AgentLookup = {
  id: string; name: string; commissionRate: number; active: boolean; employeeName: string
}
export type CommissionLookup = {
  id: string; amount: number; status: string; createdAt: string; agentName: string
}
export type LoanLookup = {
  id: string; status: string; expectedReturnDate: string | null; notes: string | null
  createdAt: string; customerName: string; itemCount: number
}

export function fetchEmployees(query = '', limit = 30) {
  const p = new URLSearchParams()
  if (query) p.set('query', query)
  p.set('limit', String(limit))
  return getJson<EmployeeLookup[]>(`/people/employees?${p.toString()}`)
}
export function fetchAgents(limit = 30) {
  return getJson<AgentLookup[]>(`/people/agents?limit=${limit}`)
}
export function fetchCommissions(options?: { agentId?: string; status?: string; limit?: number }) {
  const p = new URLSearchParams()
  if (options?.agentId) p.set('agentId', options.agentId)
  if (options?.status) p.set('status', options.status)
  p.set('limit', String(options?.limit ?? 30))
  return getJson<CommissionLookup[]>(`/people/commissions?${p.toString()}`)
}
export function fetchLoans(options?: { status?: string; limit?: number }) {
  const p = new URLSearchParams()
  if (options?.status) p.set('status', options.status)
  p.set('limit', String(options?.limit ?? 30))
  return getJson<LoanLookup[]>(`/loans?${p.toString()}`)
}

export function createEmployee(input: {
  name: string
  role?: string
  email?: string
  phone?: string
}) {
  return postJson<{ id: string }>('/people/employees', input)
}

export function createSalesAgent(input: {
  employeeId?: string
  name: string
  commissionRate: number
}) {
  return postJson<{ id: string }>('/people/agents', input)
}

export function createCommission(input: {
  salesOrderId?: string
  agentId?: string
  amount: number
}) {
  return postJson<{ id: string }>('/people/commissions', input)
}

export function createCommissionFromOrder(input: { salesOrderId: string }) {
  return postJson<{ commissionId: string; amount: number }>(
    '/people/commissions/from-order',
    input,
  )
}

export function createLoan(input: {
  customerId?: string
  expectedReturnDate?: string
  notes?: string
  items: Array<{
    product_id?: string
    quantity: number
  }>
}) {
  return postJson<{ loanOrderId: string }>('/loans', input)
}

export function updateEmployee(id: string, input: { name: string; role?: string; email?: string; phone?: string }) {
  return putJson<{ id: string }>(`/people/employees/${id}`, input)
}

export function toggleEmployeeStatus(id: string) {
  return patchJson<{ id: string; status: string }>(`/people/employees/${id}/deactivate`, {})
}

export function toggleAgentActive(id: string) {
  return patchJson<{ id: string; active: boolean }>(`/people/agents/${id}/deactivate`, {})
}

export function payCommission(id: string) {
  return patchJson<{ id: string }>(`/people/commissions/${id}/pay`, {})
}

export function cancelCommission(id: string) {
  return patchJson<{ id: string }>(`/people/commissions/${id}/cancel`, {})
}

export function returnLoan(id: string) {
  return patchJson<{ id: string }>(`/loans/${id}/return`, {})
}

export function updateLoanStatus(id: string, status: 'overdue' | 'cancelled') {
  return patchJson<{ id: string }>(`/loans/${id}/status`, { status })
}
