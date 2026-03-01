import { getJson, patchJson, postJson } from './http'

function generateIdempotencyKey(prefix: string) {
  if (globalThis.crypto !== undefined && 'randomUUID' in globalThis.crypto) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function idempotencyHeader(prefix: string, idempotencyKey?: string): HeadersInit {
  return {
    'Idempotency-Key': idempotencyKey?.trim() || generateIdempotencyKey(prefix),
  }
}

export type AppointmentLookup = {
  id: string
  subject: string
  scheduledAt: string
  status: string
  notes: string | null
  customerName: string
}

export type CallLogLookup = {
  id: string
  phone: string | null
  outcome: string | null
  notes: string | null
  occurredAt: string
  customerName: string
}

export type CampaignLookup = {
  id: string
  name: string
  channel: string | null
  status: string
  startsAt: string | null
  endsAt: string | null
  createdAt: string
}

export type PromotionLookup = {
  id: string
  name: string
  promoPrice: number
  status: string
  startAt: string | null
  endAt: string | null
  productName: string
}

export type ReturnOrderLookup = {
  id: string
  status: string
  reason: string | null
  createdAt: string
  customerName: string
  itemCount: number
}

export function fetchAppointments(options?: { from?: string; to?: string; limit?: number }) {
  const params = new URLSearchParams()
  if (options?.from) params.set('from', options.from)
  if (options?.to) params.set('to', options.to)
  if (options?.limit) params.set('limit', String(options.limit))
  const path = params.size > 0 ? `/crm/appointments?${params.toString()}` : '/crm/appointments'
  return getJson<AppointmentLookup[]>(path)
}

export function fetchCallLogs(limit = 20) {
  return getJson<CallLogLookup[]>(`/crm/calls?limit=${limit}`)
}

export function fetchCampaigns(limit = 20) {
  return getJson<CampaignLookup[]>(`/crm/campaigns?limit=${limit}`)
}

export function fetchPromotions(limit = 20) {
  return getJson<PromotionLookup[]>(`/crm/promotions?limit=${limit}`)
}

export function fetchReturnOrders(limit = 20) {
  return getJson<ReturnOrderLookup[]>(`/returns?limit=${limit}`)
}

export function createAppointment(input: {
  customerId?: string
  subject: string
  scheduledAt: string
  notes?: string
}) {
  return postJson<{ id: string }>('/crm/appointments', input)
}

export function createCallLog(input: {
  customerId?: string
  phone?: string
  outcome?: string
  notes?: string
}) {
  return postJson<{ id: string }>('/crm/calls', input)
}

export function createCampaign(input: {
  name: string
  channel?: string
  startsAt?: string
  endsAt?: string
}) {
  return postJson<{ id: string }>('/crm/campaigns', input)
}

export function addCampaignContact(input: {
  campaignId: string
  customerId?: string
  email?: string
  phone?: string
}) {
  return postJson<{ id: string }>(`/crm/campaigns/${input.campaignId}/contacts`, {
    customerId: input.customerId,
    email: input.email,
    phone: input.phone,
  })
}

export function createPromotion(input: {
  productId?: string
  name: string
  promoPrice: number
  startAt?: string
  endAt?: string
}) {
  return postJson<{ id: string }>('/crm/promotions', input)
}

export function createInventoryCount(input: {
  warehouseId?: string
  items: Array<{
    product_id?: string
    expected_qty: number
    counted_qty: number
  }>
}, options?: { idempotencyKey?: string }) {
  return postJson<{ countId: string; adjustedItems: number }>('/inventory/counts', input, {
    headers: idempotencyHeader('inventory-count-create', options?.idempotencyKey),
  })
}

export function createReturnOrder(input: {
  customerId?: string
  reason?: string
  items: Array<{
    product_id?: string
    quantity: number
    condition?: string
  }>
}) {
  return postJson<{ returnOrderId: string }>('/returns', input)
}

export function updateAppointmentStatus(id: string, status: 'completed' | 'cancelled') {
  return patchJson<{ id: string }>(`/crm/appointments/${id}/status`, { status })
}

export function updateCampaignStatus(id: string, status: 'active' | 'completed') {
  return patchJson<{ id: string }>(`/crm/campaigns/${id}/status`, { status })
}

export type CampaignContactLookup = {
  id: string
  email: string | null
  phone: string | null
  createdAt: string
  customerName: string
}

export function fetchCampaignContacts(campaignId: string) {
  return getJson<CampaignContactLookup[]>(`/crm/campaigns/${campaignId}/contacts`)
}

export function updatePromotionStatus(id: string, status: 'active' | 'ended') {
  return patchJson<{ id: string }>(`/crm/promotions/${id}/status`, { status })
}

export function updateReturnStatus(id: string, status: 'approved' | 'received' | 'refunded') {
  return patchJson<{ id: string }>(`/returns/${id}/status`, { status })
}

export type PipelineStage = 'contact' | 'qualified' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost'

export type PipelineLead = {
  id: string
  name: string
  stage: PipelineStage
  estimatedValue: number | null
  notes: string | null
  createdAt: string
  updatedAt: string
  customerName: string
}

export type CustomerHistoryItem = {
  id: string
  type: 'sale' | 'appointment' | 'call' | 'return'
  subject?: string
  status?: string
  amount?: number
  createdAt: string
}

export type CouponLookup = {
  id: string
  code: string
  couponType: 'percent' | 'fixed'
  value: number
  maxUses: number | null
  usesCount: number
  validUntil: string | null
  active: boolean
  createdAt: string
}

export function fetchPipeline() {
  return getJson<PipelineLead[]>('/crm/pipeline')
}

export function createPipelineLead(input: { name: string; customerId?: string; estimatedValue?: number; notes?: string }) {
  return postJson<{ id: string }>('/crm/pipeline', input)
}

export function updatePipelineStage(id: string, stage: PipelineStage) {
  return patchJson<{ id: string }>(`/crm/pipeline/${id}/stage`, { stage })
}

export function fetchCustomerHistory(customerId: string) {
  return getJson<CustomerHistoryItem[]>(`/crm/customers/${customerId}/history`)
}

export function fetchCoupons() {
  return getJson<CouponLookup[]>('/coupons')
}

export function createCoupon(input: { code: string; couponType: 'percent' | 'fixed'; value: number; maxUses?: number; validUntil?: string }) {
  return postJson<{ id: string }>('/coupons', input)
}

export function toggleCoupon(id: string) {
  return patchJson<{ id: string; active: boolean }>(`/coupons/${id}/toggle`, {})
}
