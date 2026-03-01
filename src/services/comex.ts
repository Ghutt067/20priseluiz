import { getJson, postJson, patchJson } from './http'

export type ImportProcess = {
  id: string; referenceNumber: string | null; incoterm: string; currency: string
  exchangeRate: number | null; totalFob: number; totalNationalized: number
  status: string; supplierName: string | null; createdAt: string
}

export type ImportContainer = {
  id: string; processId: string; containerNumber: string | null
  containerType: string; billOfLading: string | null; shippingDate: string | null
  etaPort: string | null; actualArrival: string | null; status: string; createdAt: string
}

export function fetchProcesses(status?: string) {
  const q = status ? `?status=${status}` : ''
  return getJson<ImportProcess[]>(`/comex/processes${q}`)
}

export function createProcess(input: {
  supplierId?: string; referenceNumber?: string
  incoterm?: string; currency?: string; exchangeRate?: number
  items: Array<{ productId: string; quantity: number; fobUnitPrice: number }>
}) {
  return postJson<{ id: string; totalFob: number }>('/comex/processes', input)
}

export function addProcessCost(processId: string, input: {
  costType: string; description?: string; amountOriginal: number; amountBrl: number
}) {
  return postJson<{ id: string }>(`/comex/processes/${processId}/costs`, input)
}

export function nationalizeProcess(processId: string) {
  return postJson<{ totalNationalized: number; itemsProcessed: number }>(`/comex/processes/${processId}/nationalize`, {})
}

export function fetchContainers(processId?: string) {
  const q = processId ? `?processId=${processId}` : ''
  return getJson<ImportContainer[]>(`/comex/containers${q}`)
}

export function createContainer(input: {
  processId: string; containerNumber?: string; containerType?: string
  billOfLading?: string; shippingDate?: string; etaPort?: string
}) {
  return postJson<{ id: string }>('/comex/containers', input)
}

export function updateProcessStatus(id: string, input: { status?: string; exchangeRate?: number }) {
  return patchJson<{ id: string }>(`/comex/processes/${id}`, input)
}

export function updateContainerStatus(id: string, input: { status?: string; actualArrival?: string }) {
  return patchJson<{ id: string }>(`/comex/containers/${id}`, input)
}
