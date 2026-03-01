import { getJsonWithHeaders, postJson } from './http'

function parseTotalCount(headers: Headers) {
  const raw = headers.get('x-total-count')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(parsed, 0)
}

export type ShipmentLookup = {
  id: string
  salesOrderId: string | null
  customerId: string | null
  customerName: string | null
  type: 'delivery' | 'pickup'
  status: 'pending' | 'dispatched' | 'delivered' | 'cancelled'
  carrier: string | null
  trackingCode: string | null
  dispatchedAt: string | null
  deliveredAt: string | null
  createdAt: string
  itemsCount: number
  totalQuantity: string | number
}

export function createShipment(input: {
  salesOrderId?: string
  customerId?: string
  type?: 'delivery' | 'pickup'
  carrier?: string
  trackingCode?: string
  items: Array<{
    product_id?: string
    quantity: number
  }>
}) {
  return postJson<{ shipmentId: string }>('/shipping/shipments', input)
}

export async function fetchShipmentsPaged(options?: {
  status?: '' | 'pending' | 'dispatched' | 'delivered' | 'cancelled'
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<{ rows: ShipmentLookup[]; totalCount: number | null }> {
  const params = new URLSearchParams()
  const status = options?.status?.trim() ?? ''
  const query = options?.query?.trim() ?? ''

  if (status) {
    params.set('status', status)
  }
  if (query) {
    params.set('query', query)
  }

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(Math.max(1, Math.floor(options.limit))))
  }
  if (typeof options?.offset === 'number' && Number.isFinite(options.offset)) {
    params.set('offset', String(Math.max(0, Math.floor(options.offset))))
  }

  const path = params.size > 0 ? `/shipping/shipments?${params.toString()}` : '/shipping/shipments'
  const { data, headers } = await getJsonWithHeaders<ShipmentLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseTotalCount(headers),
  }
}

export function dispatchShipment(shipmentId: string) {
  return postJson<{ shipmentId: string }>(`/shipping/shipments/${shipmentId}/dispatch`, {})
}

export function deliverShipment(shipmentId: string) {
  return postJson<{ shipmentId: string }>(`/shipping/shipments/${shipmentId}/deliver`, {})
}
