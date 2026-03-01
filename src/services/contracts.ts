import { getJson, getJsonWithHeaders, patchJson, postJson } from './http'

export type ContractLookup = {
  id: string
  status: string
  startDate: string
  endDate: string | null
  billingDay: number
  createdAt: string
  customerName: string
  totalAmount: number | string
  itemCount: number
}

export type ContractDetail = ContractLookup & {
  customerId: string | null
  items: Array<{
    id: string
    description: string
    quantity: number
    unitPrice: number
  }>
}

export async function fetchContractsPaged(options?: {
  status?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<{ rows: ContractLookup[]; totalCount: number }> {
  const params = new URLSearchParams()
  if (options?.status) params.set('status', options.status)
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.offset) params.set('offset', String(options.offset))
  const path = params.size > 0 ? `/contracts?${params.toString()}` : '/contracts'
  const { data, headers } = await getJsonWithHeaders<ContractLookup[]>(path, { signal: options?.signal })
  const raw = headers.get('x-total-count')
  const totalCount = raw ? Math.max(Number.parseInt(raw, 10) || 0, 0) : data.length
  return { rows: data, totalCount }
}

export function fetchContractDetail(id: string) {
  return getJson<ContractDetail>(`/contracts/${id}`)
}

export function createContract(input: {
  customerId?: string
  startDate: string
  endDate?: string
  billingDay?: number
  items: Array<{ description: string; quantity: number; unitPrice: number }>
}) {
  return postJson<{ contractId: string }>('/contracts', input)
}

export function updateContractStatus(id: string, status: 'active' | 'paused' | 'cancelled') {
  return patchJson<{ id: string; status: string }>(`/contracts/${id}/status`, { status })
}
