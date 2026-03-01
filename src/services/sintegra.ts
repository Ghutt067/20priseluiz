import { getJson, postJson } from './http'

export type SintegraExportLookup = {
  id: string
  periodStart: string
  periodEnd: string
  status: string
  generatedAt: string | null
  createdAt: string
}

export function fetchSintegraExports() {
  return getJson<SintegraExportLookup[]>('/sintegra/exports')
}

export function createSintegraExport(input: { periodStart: string; periodEnd: string }) {
  return postJson<{ id: string }>('/sintegra/exports', input)
}

export function generateSintegraExport(id: string) {
  return postJson<{ id: string }>(`/sintegra/exports/${id}/generate`, {})
}
