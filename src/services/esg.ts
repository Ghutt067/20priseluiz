import { getJson, postJson, patchJson } from './http'

export type CarbonSummary = {
  byType: Array<{ entryType: string; totalCo2Kg: number; totalQuantity: number; entries: number }>
  totalCo2Kg: number
}

export type ComplianceReport = {
  id: string; reportType: string; description: string
  isAnonymous: boolean; status: string; assignedTo: string | null
  resolution: string | null; resolvedAt: string | null; createdAt: string
}

export function fetchCarbonSummary(from?: string, to?: string) {
  const p = new URLSearchParams()
  if (from) p.set('from', from)
  if (to) p.set('to', to)
  const q = p.size > 0 ? `?${p}` : ''
  return getJson<CarbonSummary>(`/esg/carbon${q}`)
}

export function createCarbonEntry(input: {
  entryType: string; periodStart: string; periodEnd: string
  quantity: number; unit: string; emissionFactor: number; notes?: string
}) {
  return postJson<{ id: string; co2Kg: number }>('/esg/carbon', input)
}

export function autoCalculateFleetCarbon(periodStart: string, periodEnd: string) {
  return postJson<{ totalLiters: number; co2Kg: number }>('/esg/carbon/auto-calculate-fleet', { periodStart, periodEnd })
}

export function fetchComplianceReports(status?: string) {
  const q = status ? `?status=${status}` : ''
  return getJson<ComplianceReport[]>(`/esg/compliance${q}`)
}

export function createComplianceReport(input: {
  reportType: string; description: string; isAnonymous?: boolean
}) {
  return postJson<{ id: string }>('/esg/compliance', input)
}

export function updateComplianceReport(id: string, input: {
  status?: string; resolution?: string; assignedTo?: string
}) {
  return patchJson<{ id: string }>(`/esg/compliance/${id}`, input)
}
