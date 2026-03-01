import { getJson, getJsonWithHeaders, postJson, patchJson } from './http'

export type FixedAsset = {
  id: string; name: string; category: string; assetNumber: string | null
  acquisitionValue: number; acquisitionDate: string; usefulLifeMonths: number
  depreciationMethod: string; residualValue: number; currentValue: number | null
  responsibleUserId: string | null; locationDescription: string | null
  status: string; notes: string | null; createdAt: string
}

export type AssetDepreciation = {
  id: string; referenceMonth: string; depreciationValue: number
  accumulatedDepreciation: number; bookValue: number; createdAt: string
}

export type AssetTransfer = {
  id: string; fromUserId: string | null; toUserId: string
  transferDate: string; reason: string | null; createdAt: string
}

export async function fetchAssetsPaged(options?: {
  query?: string; status?: string; category?: string; limit?: number; offset?: number; signal?: AbortSignal
}): Promise<{ rows: FixedAsset[]; totalCount: number }> {
  const p = new URLSearchParams()
  if (options?.query) p.set('query', options.query)
  if (options?.status) p.set('status', options.status)
  if (options?.category) p.set('category', options.category)
  if (options?.limit) p.set('limit', String(options.limit))
  if (options?.offset) p.set('offset', String(options.offset))
  const path = p.size > 0 ? `/assets?${p}` : '/assets'
  const { data, headers } = await getJsonWithHeaders<FixedAsset[]>(path, { signal: options?.signal })
  const raw = headers.get('x-total-count')
  return { rows: data, totalCount: raw ? Math.max(Number.parseInt(raw, 10) || 0, 0) : data.length }
}

export function createAsset(input: {
  name: string; category: string; assetNumber?: string
  acquisitionValue: number; acquisitionDate: string; usefulLifeMonths?: number
  depreciationMethod?: string; residualValue?: number
  responsibleUserId?: string; locationDescription?: string; notes?: string
}) {
  return postJson<{ id: string }>('/assets', input)
}

export function calculateDepreciation(referenceMonth: string) {
  return postJson<{ calculated: number; referenceMonth: string }>('/assets/calculate-depreciation', { referenceMonth })
}

export function fetchAssetDepreciations(assetId: string) {
  return getJson<AssetDepreciation[]>(`/assets/${assetId}/depreciations`)
}

export function transferAsset(assetId: string, input: { toUserId: string; reason?: string }) {
  return postJson<{ transferred: boolean }>(`/assets/${assetId}/transfer`, input)
}

export function fetchAssetTransfers(assetId: string) {
  return getJson<AssetTransfer[]>(`/assets/${assetId}/transfers`)
}

export function updateAsset(id: string, input: { name?: string; category?: string; status?: string; locationDescription?: string; notes?: string }) {
  return patchJson<{ id: string }>(`/assets/${id}`, input)
}
