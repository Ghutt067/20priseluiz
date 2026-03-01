import { supabase } from '../lib/supabase'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'
const orgStorageKey = 'vinteenterprise.organizationId'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getOrgHeader(): Record<string, string> {
  if (globalThis.window === undefined) return {}
  const organizationId = globalThis.window.localStorage
    .getItem(orgStorageKey)
    ?.trim()
  if (!organizationId) return {}
  if (!uuidPattern.test(organizationId)) return {}
  return organizationId ? { 'x-organization-id': organizationId } : {}
}

function mergeHeaders(...headersList: Array<HeadersInit | undefined>): Record<string, string> {
  const headers = new Headers()
  for (const item of headersList) {
    if (!item) continue
    const normalized = new Headers(item)
    normalized.forEach((value, key) => headers.set(key, value))
  }
  return Object.fromEntries(headers.entries())
}

async function getAuthHeader(): Promise<Record<string, string>> {
  if (globalThis.window === undefined) return {}
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function buildApiHeaders(options?: {
  json?: boolean
  extra?: HeadersInit
}): Promise<Record<string, string>> {
  const authHeader = await getAuthHeader()
  return mergeHeaders(
    options?.json ? { 'Content-Type': 'application/json' } : undefined,
    getOrgHeader(),
    authHeader,
    options?.extra,
  )
}

export async function postJson<T>(
  path: string,
  body: unknown,
  options?: { headers?: HeadersInit },
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: await buildApiHeaders({ json: true, extra: options?.headers }),
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? 'Falha na operacao.')
  }

  return response.json()
}

export async function getJsonWithHeaders<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: await buildApiHeaders({ extra: init?.headers }),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? 'Falha na operacao.')
  }

  const data = (await response.json()) as T
  return {
    data,
    headers: response.headers,
  }
}

export async function putJson<T>(
  path: string,
  body: unknown,
  options?: { headers?: HeadersInit },
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'PUT',
    headers: await buildApiHeaders({ json: true, extra: options?.headers }),
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? 'Falha na operacao.')
  }

  return response.json()
}

export async function patchJson<T>(
  path: string,
  body?: unknown,
  options?: { headers?: HeadersInit },
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'PATCH',
    headers: await buildApiHeaders({ json: true, extra: options?.headers }),
    body: JSON.stringify(body ?? {}),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? 'Falha na operacao.')
  }

  return response.json()
}

export async function deleteJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'DELETE',
    headers: await buildApiHeaders(),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? 'Falha na operacao.')
  }

  return response.json()
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: await buildApiHeaders({ extra: init?.headers }),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? 'Falha na operacao.')
  }

  return response.json()
}
