import { getJson, postJson, patchJson, deleteJson } from './http'

export type AutomationRule = {
  id: string; name: string; triggerEvent: string
  conditions: Record<string, unknown>; actions: Record<string, unknown>[]
  active: boolean; executionCount: number; lastTriggeredAt: string | null; createdAt: string
}

export type AutomationExecution = {
  id: string; ruleId: string; ruleName: string
  triggerData: Record<string, unknown> | null; result: string
  errorMessage: string | null; executedAt: string
}

export type SignatureRequest = {
  id: string; documentType: string; documentId: string; provider: string
  signerName: string; signerEmail: string; status: string
  signedAt: string | null; sentAt: string | null
  documentUrl: string | null; createdAt: string
}

export function fetchRules() {
  return getJson<AutomationRule[]>('/automation/rules')
}

export function createRule(input: {
  name: string; triggerEvent: string
  conditions?: Record<string, unknown>; actions: Record<string, unknown>[]
}) {
  return postJson<{ id: string }>('/automation/rules', input)
}

export function toggleRule(ruleId: string) {
  return patchJson<{ id: string; active: boolean }>(`/automation/rules/${ruleId}/toggle`)
}

export function fetchExecutions(ruleId?: string) {
  const q = ruleId ? `?ruleId=${ruleId}` : ''
  return getJson<AutomationExecution[]>(`/automation/executions${q}`)
}

export function fetchSignatures(status?: string) {
  const q = status ? `?status=${status}` : ''
  return getJson<SignatureRequest[]>(`/automation/signatures${q}`)
}

export function createSignatureRequest(input: {
  documentType: string; documentId: string; provider?: string
  signerName: string; signerEmail: string
}) {
  return postJson<{ id: string }>('/automation/signatures', input)
}

export function deleteRule(id: string) {
  return deleteJson<{ deleted: boolean }>(`/automation/rules/${id}`)
}

export function updateSignatureStatus(id: string, status: string) {
  return patchJson<{ id: string }>(`/automation/signatures/${id}`, { status })
}
