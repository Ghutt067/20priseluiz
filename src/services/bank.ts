import { getJson, patchJson, postJson } from './http'

export type BankIntegrationLookup = {
  id: string
  provider: string
  name: string | null
  active: boolean
  createdAt: string
}

export function fetchBankIntegrations() {
  return getJson<BankIntegrationLookup[]>('/bank/integrations')
}

export function createBankIntegration(input: {
  provider: 'pix' | 'boleto' | 'bank_api'
  name?: string
  config?: Record<string, unknown>
}) {
  return postJson<{ id: string }>('/bank/integrations', input)
}

export function registerBankWebhook(input: {
  integrationId?: string
  eventType: string
  payload: Record<string, unknown>
}) {
  return postJson<{ id: string }>('/bank/webhooks', input)
}

export function processWebhookPayment(input: {
  installmentId: string
  accountId?: string
  amount: number
  method?: string
}) {
  return postJson<{ installmentId: string }>('/bank/webhooks/process-payment', input)
}

export function toggleBankIntegration(id: string) {
  return patchJson<{ id: string; active: boolean }>(`/bank/integrations/${id}/toggle`, {})
}

export type WebhookEventLookup = {
  id: string
  eventType: string
  status: string
  createdAt: string
  integrationName: string
}

export function fetchWebhookEvents(limit = 30) {
  return getJson<WebhookEventLookup[]>(`/bank/webhooks?limit=${limit}`)
}

export type FinancialAccountLookup = {
  id: string
  name: string
  type: string
  balance: number
  createdAt: string
}

export function fetchFinancialAccounts() {
  return getJson<FinancialAccountLookup[]>('/finance/accounts')
}

export function createFinancialAccount(input: { name: string; type?: 'bank' | 'cash' | 'card' }) {
  return postJson<{ id: string }>('/finance/accounts', input)
}
