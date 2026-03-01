import { getJson, postJson } from './http'

export type PosSession = {
  sessionId: string
  cashierId: string | null
  openedAt: string
}

export type PosSessionSale = {
  posSaleId: string
  totalAmount: number
  createdAt: string
  customerName: string
}

export type PosSessionSummary = {
  salesCount: number
  totalRevenue: number
}

export type PosSessionReport = {
  sessionId: string
  status: string
  openedAt: string
  closedAt: string | null
  openingAmount: number
  closingAmount: number | null
  salesCount: number
  totalRevenue: number
  byMethod: Array<{ method: string; total: number; count: number }>
  movements: Array<{ type: string; total: number }>
  expectedCash: number
}

export function openPosSession(input: { cashierId?: string; openingAmount?: number }) {
  return postJson<{ sessionId: string }>('/pos/sessions/open', input)
}

export function posSessionSangria(sessionId: string, amount: number, notes?: string) {
  return postJson<{ id: string }>(`/pos/sessions/${sessionId}/sangria`, { amount, notes })
}

export function posSessionReforco(sessionId: string, amount: number, notes?: string) {
  return postJson<{ id: string }>(`/pos/sessions/${sessionId}/reforco`, { amount, notes })
}

export function fetchPosSessionReport(sessionId: string) {
  return getJson<PosSessionReport>(`/pos/sessions/${sessionId}/report`)
}

export function closeSessionWithReport(sessionId: string, closingAmount?: number) {
  return postJson<{ sessionId: string }>(`/pos/sessions/${sessionId}/close-with-report`, { closingAmount })
}

export function closePosSession(sessionId: string) {
  return postJson<{ sessionId: string }>(`/pos/sessions/${sessionId}/close`, {})
}

export function fetchCurrentPosSession() {
  return getJson<PosSession | null>('/pos/sessions/current')
}

export function fetchPosSessionSales(sessionId: string) {
  return getJson<PosSessionSale[]>(`/pos/sessions/${sessionId}/sales`)
}

export function fetchPosSessionSummary(sessionId: string) {
  return getJson<PosSessionSummary>(`/pos/sessions/${sessionId}/summary`)
}

export function createPosSale(input: {
  posSessionId?: string
  customerId?: string
  items: Array<{
    product_id?: string
    quantity: number
    unit_price: number
    discount_value?: number
    discount_mode?: 'percent' | 'value'
  }>
  payments: Array<{
    method: string
    amount: number
  }>
  customerCpf?: string
  globalDiscountPct?: number
}) {
  return postJson<{ posSaleId: string; totalAmount: number }>('/pos/sales', input)
}

export function cancelPosSale(saleId: string) {
  return postJson<{ saleId: string; cancelled: boolean; totalAmount: number }>(
    `/pos/sales/${encodeURIComponent(saleId)}/cancel`,
    {},
  )
}
