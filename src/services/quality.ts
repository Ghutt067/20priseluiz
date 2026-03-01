import { getJson, postJson, patchJson } from './http'

export type NcrReport = {
  id: string; ncrNumber: number; ncrType: string; title: string
  description: string | null; rootCause: string | null; severity: string
  status: string; actionPlan: Record<string, unknown> | null
  responsibleUserId: string | null; createdAt: string
}

export type CalibrationInstrument = {
  id: string; name: string; code: string; instrumentType: string | null
  lastCalibration: string | null; nextCalibration: string | null
  calibrationIntervalDays: number; status: string
  certificateUrl: string | null; notes: string | null
}

export type ControlledDocument = {
  id: string; title: string; docType: string; currentVersion: string
  status: string; approvedBy: string | null; approvedAt: string | null
  contentUrl: string | null; notes: string | null; createdAt: string
}

export function fetchNcrs(status?: string) {
  const q = status ? `?status=${status}` : ''
  return getJson<NcrReport[]>(`/quality/ncr${q}`)
}

export function createNcr(input: {
  ncrType: string; title: string; description?: string
  severity?: string; responsibleUserId?: string; productId?: string; supplierId?: string
}) {
  return postJson<{ id: string; ncrNumber: number }>('/quality/ncr', input)
}

export function updateNcr(id: string, input: {
  status?: string; rootCause?: string; actionPlan?: Record<string, unknown>
}) {
  return patchJson<{ id: string }>(`/quality/ncr/${id}`, input)
}

export function fetchCalibration(status?: string) {
  const q = status ? `?status=${status}` : ''
  return getJson<CalibrationInstrument[]>(`/quality/calibration${q}`)
}

export function createCalibrationInstrument(input: {
  name: string; code: string; instrumentType?: string
  calibrationIntervalDays?: number; lastCalibration?: string
}) {
  return postJson<{ id: string }>('/quality/calibration', input)
}

export function fetchDocuments(status?: string, docType?: string) {
  const p = new URLSearchParams()
  if (status) p.set('status', status)
  if (docType) p.set('docType', docType)
  const q = p.size > 0 ? `?${p}` : ''
  return getJson<ControlledDocument[]>(`/quality/documents${q}`)
}

export function createDocument(input: {
  title: string; docType: string; contentUrl?: string; notes?: string
}) {
  return postJson<{ id: string }>('/quality/documents', input)
}

export function approveDocument(id: string) {
  return postJson<{ approved: boolean }>(`/quality/documents/${id}/approve`, {})
}
