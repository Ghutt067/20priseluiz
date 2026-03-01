import { getJson, getJsonWithHeaders, postJson, patchJson } from './http'

export type BomLookup = {
  id: string; name: string; version: string; active: boolean
  productId: string; productName: string; productSku: string; createdAt: string
}

export type BomDetail = {
  bom: { id: string; name: string; version: string; active: boolean; productId: string; productName: string }
  items: Array<{
    id: string; componentProductId: string; componentName: string; componentSku: string
    qtyPerUnit: number; unitOfMeasure: string; scrapPct: number
  }>
}

export type ProductionOrder = {
  id: string; status: string; qtyPlanned: number; qtyProduced: number
  startDate: string | null; endDate: string | null
  productName: string; bomName: string; warehouseName: string; createdAt: string
}

export type MrpExplosionRow = {
  componentProductId: string; componentName: string; componentSku: string
  grossRequired: number; freeStock: number; netRequired: number
}

export type ProductionCostSummary = {
  items: Array<{ id: string; costType: string; description: string | null; amount: number; createdAt: string }>
  totalCost: number; unitCost: number
}

export async function fetchBomsPaged(options?: {
  query?: string; limit?: number; offset?: number; signal?: AbortSignal
}): Promise<{ rows: BomLookup[]; totalCount: number }> {
  const p = new URLSearchParams()
  if (options?.query) p.set('query', options.query)
  if (options?.limit) p.set('limit', String(options.limit))
  if (options?.offset) p.set('offset', String(options.offset))
  const path = p.size > 0 ? `/mrp/bom?${p}` : '/mrp/bom'
  const { data, headers } = await getJsonWithHeaders<BomLookup[]>(path, { signal: options?.signal })
  const raw = headers.get('x-total-count')
  return { rows: data, totalCount: raw ? Math.max(Number.parseInt(raw, 10) || 0, 0) : data.length }
}

export function fetchBomDetail(id: string) {
  return getJson<BomDetail>(`/mrp/bom/${id}`)
}

export function createBom(input: {
  productId: string; name: string; version?: string
  items: Array<{ componentProductId: string; qtyPerUnit: number; unitOfMeasure?: string; scrapPct?: number }>
}) {
  return postJson<{ id: string }>('/mrp/bom', input)
}

export function fetchMrpExplosion() {
  return getJson<MrpExplosionRow[]>('/mrp/explosion')
}

export async function fetchProductionOrdersPaged(options?: {
  status?: string; limit?: number; offset?: number; signal?: AbortSignal
}): Promise<{ rows: ProductionOrder[]; totalCount: number }> {
  const p = new URLSearchParams()
  if (options?.status) p.set('status', options.status)
  if (options?.limit) p.set('limit', String(options.limit))
  if (options?.offset) p.set('offset', String(options.offset))
  const path = p.size > 0 ? `/mrp/production-orders?${p}` : '/mrp/production-orders'
  const { data, headers } = await getJsonWithHeaders<ProductionOrder[]>(path, { signal: options?.signal })
  const raw = headers.get('x-total-count')
  return { rows: data, totalCount: raw ? Math.max(Number.parseInt(raw, 10) || 0, 0) : data.length }
}

export function createProductionOrder(input: {
  bomId: string; productId: string; warehouseId: string
  qtyPlanned: number; startDate?: string; endDate?: string; notes?: string
}) {
  return postJson<{ id: string }>('/mrp/production-orders', input)
}

export function reportProduction(orderId: string, input: {
  qtyProduced: number
  consumptions?: Array<{ componentProductId: string; qtyConsumed: number }>
}) {
  return postJson<{ qtyProduced: number }>(`/mrp/production-orders/${orderId}/report`, input)
}

export function addProductionCost(orderId: string, input: {
  costType: string; description?: string; amount: number
}) {
  return postJson<{ id: string }>(`/mrp/production-orders/${orderId}/costs`, input)
}

export function fetchProductionCosts(orderId: string) {
  return getJson<ProductionCostSummary>(`/mrp/production-orders/${orderId}/costs`)
}

export function createMachineStop(input: {
  productionOrderId?: string; machineName: string; startedAt: string; endedAt?: string; reason?: string
}) {
  return postJson<{ id: string }>('/mrp/machine-stops', input)
}

export function createWaste(input: {
  productionOrderId: string; componentProductId: string; qtyWasted: number; reason?: string
}) {
  return postJson<{ id: string }>('/mrp/waste', input)
}

export function updateBom(id: string, input: { active?: boolean; version?: string }) {
  return patchJson<{ id: string }>(`/mrp/bom/${id}`, input)
}

export function updateProductionOrder(id: string, input: { status?: string; startDate?: string; endDate?: string; notes?: string }) {
  return patchJson<{ id: string }>(`/mrp/production-orders/${id}`, input)
}

export type BomLookupItem = { id: string; name: string; productName: string }

export async function searchBomsLookup(params: {
  query: string; offset: number; limit: number; signal?: AbortSignal
}): Promise<{ rows: BomLookupItem[]; totalCount: number | null }> {
  const r = await fetchBomsPaged({ query: params.query, offset: params.offset, limit: params.limit, signal: params.signal })
  return {
    rows: r.rows.map(b => ({ id: b.id, name: `${b.name} (${b.productName})`, productName: b.productName })),
    totalCount: r.totalCount,
  }
}

export type MrpDashboard = {
  activeOrders: number
  lateOrders: number
  completedThisMonth: number
  totalBoms: number
}

export async function fetchMrpDashboard(): Promise<MrpDashboard> {
  const [orders, boms] = await Promise.all([
    fetchProductionOrdersPaged({ limit: 1000 }),
    fetchBomsPaged({ limit: 1 }),
  ])
  const active = orders.rows.filter(o => ['planned', 'released', 'in_progress'].includes(o.status)).length
  const now = new Date()
  const late = orders.rows.filter(o => o.endDate && new Date(o.endDate) < now && !['completed', 'closed'].includes(o.status)).length
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const completed = orders.rows.filter(o => o.status === 'completed' && o.endDate && o.endDate >= monthStart).length
  return { activeOrders: active, lateOrders: late, completedThisMonth: completed, totalBoms: boms.totalCount }
}
