import { getJson, getJsonWithHeaders, postJson, patchJson, deleteJson } from './http'

export type WarehouseLocation = {
  id: string; warehouseId: string; warehouseName: string
  aisle: string; shelf: string; level: string; code: string
  active: boolean; createdAt: string
}

export type PickList = {
  id: string; status: string; shipmentId: string | null; salesOrderId: string | null
  pickedAt: string | null; packedAt: string | null; createdAt: string; itemCount: number
}

export type CubageResult = {
  totalWeightKg: number; totalVolumeM3: number
  items: Array<{ productId: string; productName: string; quantity: number; weightKg: number; volumeM3: number }>
}

export async function fetchLocationsPaged(options?: {
  warehouseId?: string; query?: string; limit?: number; offset?: number; signal?: AbortSignal
}): Promise<{ rows: WarehouseLocation[]; totalCount: number }> {
  const p = new URLSearchParams()
  if (options?.warehouseId) p.set('warehouseId', options.warehouseId)
  if (options?.query) p.set('query', options.query)
  if (options?.limit) p.set('limit', String(options.limit))
  if (options?.offset) p.set('offset', String(options.offset))
  const path = p.size > 0 ? `/wms/locations?${p}` : '/wms/locations'
  const { data, headers } = await getJsonWithHeaders<WarehouseLocation[]>(path, { signal: options?.signal })
  const raw = headers.get('x-total-count')
  return { rows: data, totalCount: raw ? Math.max(Number.parseInt(raw, 10) || 0, 0) : data.length }
}

export function createLocation(input: {
  warehouseId: string; aisle: string; shelf: string; level: string; code: string
}) {
  return postJson<{ id: string }>('/wms/locations', input)
}

export function fetchPickLists(status?: string) {
  const q = status ? `?status=${status}` : ''
  return getJson<PickList[]>(`/wms/pick-lists${q}`)
}

export function createPickList(input: {
  shipmentId?: string; salesOrderId?: string
  items: Array<{ productId: string; locationId?: string; qtyExpected: number }>
}) {
  return postJson<{ id: string }>('/wms/pick-lists', input)
}

export function confirmPickItem(pickListId: string, input: {
  itemId: string; qtyPicked: number; barcodeScanned?: string
}) {
  return postJson<{ confirmed: boolean }>(`/wms/pick-lists/${pickListId}/confirm-item`, input)
}

export function packPickList(pickListId: string) {
  return patchJson<{ packed: boolean }>(`/wms/pick-lists/${pickListId}/pack`)
}

export function calculateCubage(items: Array<{ productId: string; quantity: number }>) {
  return postJson<CubageResult>('/wms/cubage', { items })
}

export function updateLocation(id: string, input: { active?: boolean }) {
  return patchJson<{ id: string }>(`/wms/locations/${id}`, input)
}

export function deleteLocation(id: string) {
  return deleteJson<{ deleted: boolean }>(`/wms/locations/${id}`)
}

export type WmsDashboard = {
  totalLocations: number
  activeLocations: number
  pendingPickLists: number
}

export async function fetchWmsDashboard(): Promise<WmsDashboard> {
  const [locs, picks] = await Promise.all([
    fetchLocationsPaged({ limit: 1000 }),
    fetchPickLists(),
  ])
  return {
    totalLocations: locs.totalCount,
    activeLocations: locs.rows.filter(l => l.active).length,
    pendingPickLists: picks.filter(p => !['packed', 'shipped'].includes(p.status)).length,
  }
}
