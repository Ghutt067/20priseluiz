import { buildApiHeaders } from './http'

export function generateIdempotencyKey(prefix: string) {
  if (globalThis.crypto !== undefined && 'randomUUID' in globalThis.crypto) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function idempotencyHeader(prefix: string, idempotencyKey?: string): HeadersInit {
  return {
    'Idempotency-Key': idempotencyKey?.trim() || generateIdempotencyKey(prefix),
  }
}

export type LookupPageResult<T> = {
  rows: T[]
  totalCount: number | null
}

export function parseTotalCountHeader(headers: Headers) {
  const raw = headers.get('x-total-count')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(parsed, 0)
}

export function buildLookupQueryParams(options?: {
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
  [key: string]: unknown
}) {
  const params = new URLSearchParams()
  if (!options) return params

  for (const [key, value] of Object.entries(options)) {
    if (key === 'signal') continue
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      const normalized = value.trim()
      if (!normalized) continue
      params.set(key, normalized)
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      if (key === 'offset') {
        params.set(key, String(Math.max(0, Math.floor(value))))
        continue
      }
      if (key === 'limit') {
        params.set(key, String(Math.max(1, Math.floor(value))))
        continue
      }
      params.set(key, String(value))
      continue
    }
    if (typeof value === 'boolean') {
      params.set(key, String(value))
    }
  }
  return params
}

export function buildQueryPath(basePath: string, options?: Record<string, unknown>) {
  const params = buildLookupQueryParams(options as Parameters<typeof buildLookupQueryParams>[0])
  return params.size > 0 ? `${basePath}?${params.toString()}` : basePath
}

export { buildApiHeaders }
