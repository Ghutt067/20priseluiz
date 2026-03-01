import { getJsonWithHeaders, postJson } from './http'

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

function parseTotalCount(headers: Headers) {
  const raw = headers.get('x-total-count')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(parsed, 0)
}

export type LabelLookup = {
  id: string
  productId: string | null
  productName: string | null
  productSku: string | null
  quantity: number
  status: 'pending' | 'printed'
  payload: unknown
  createdAt: string
}

export function createLabel(input: {
  productId?: string
  quantity: number
  payload?: Record<string, unknown>
}, options?: { idempotencyKey?: string }) {
  return postJson<{ id: string }>('/labels', input, {
    headers: idempotencyHeader('label-create', options?.idempotencyKey),
  })
}

export async function fetchLabelsPaged(options?: {
  status?: '' | 'pending' | 'printed'
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<{ rows: LabelLookup[]; totalCount: number | null }> {
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

  const path = params.size > 0 ? `/labels?${params.toString()}` : '/labels'
  const { data, headers } = await getJsonWithHeaders<LabelLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseTotalCount(headers),
  }
}

export function markLabelAsPrinted(labelId: string, options?: { idempotencyKey?: string }) {
  return postJson<{ id: string; status: 'printed' }>(`/labels/${labelId}/mark-printed`, {}, {
    headers: idempotencyHeader('label-mark-printed', options?.idempotencyKey),
  })
}
