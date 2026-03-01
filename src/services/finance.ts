import { getJson, getJsonWithHeaders, postJson } from './http'

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

export type LookupPageResult<T> = {
  rows: T[]
  totalCount: number | null
}

function parseLookupTotalCountHeader(headers: Headers) {
  const raw = headers.get('x-total-count')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(parsed, 0)
}

function normalizeLookupString(value: string) {
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeLookupNumber(key: string, value: number) {
  if (!Number.isFinite(value)) return null
  if (key === 'offset') return String(Math.max(0, Math.floor(value)))
  if (key === 'limit') return String(Math.max(1, Math.floor(value)))
  return String(value)
}

function normalizeLookupParamValue(key: string, value: unknown) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return normalizeLookupString(value)
  if (typeof value === 'number') return normalizeLookupNumber(key, value)
  if (typeof value === 'boolean') return String(value)
  return null
}

function buildLookupQueryParams(options?: {
  query?: string
  limit?: number
  offset?: number
  [key: string]: unknown
}) {
  const params = new URLSearchParams()

  if (!options) return params

  for (const [key, value] of Object.entries(options)) {
    const normalized = normalizeLookupParamValue(key, value)
    if (normalized === null) continue
    params.set(key, normalized)
  }

  return params
}

type FinancialTitleType = 'receivable' | 'payable'
type FinancialStatus = 'open' | 'paid' | 'canceled' | 'overdue'
type BankTransactionDirection = 'in' | 'out'
type BankTransactionStatus = 'pending' | 'cleared' | 'reconciled'
type PaymentMethod = 'cash' | 'card' | 'pix' | 'boleto' | 'transfer' | 'other'
type PaymentProvider = 'pix' | 'boleto' | 'bank_api'
type ReconciliationAdjustmentType = 'bank_fee' | 'interest' | 'pix_fee' | 'reversal' | 'other'
type ReconciliationActivitySource =
  | 'finance.reconcile.settle'
  | 'finance.reconcile.adjustment'
  | 'finance.reconcile.manual'
  | 'finance.ofx.import'

export type FinancialAccountLookup = {
  id: string
  name: string
  bankCode: string | null
  agency: string | null
  accountNumber: string | null
  active: boolean
  createdAt: string
}

export type ReconciliationActivity = {
  id: string
  createdAt: string
  actorName: string | null
  source: ReconciliationActivitySource
  bankTransactionId: string | null
  bankTransactionDescription: string | null
  bankTransactionAmount: string | number | null
  bankTransactionDirection: BankTransactionDirection | null
  reconciliationItemId: string | null
  importId: string | null
  totalCount: number | null
  importedCount: number | null
  ignoredCount: number | null
  installmentId: string | null
  installmentAmount: string | number | null
  installmentTitleType: FinancialTitleType | null
}

export type FinancialTitleLookup = {
  id: string
  titleType: FinancialTitleType
  status: FinancialStatus
  description: string | null
  totalAmount: string | number
  createdAt: string
  customerId: string | null
  customerName: string | null
  supplierId: string | null
  supplierName: string | null
  paidAmount: string | number
  openAmount: string | number
  nextDueDate: string | null
  lastDueDate: string | null
  installmentsCount: number
}

export type FinancialInstallmentLookup = {
  id: string
  titleId: string
  dueDate: string
  amount: string | number
  paidAt: string | null
  status: FinancialStatus
  titleType: FinancialTitleType
  titleDescription: string | null
  customerId: string | null
  customerName: string | null
  supplierId: string | null
  supplierName: string | null
}

export type BankTransactionLookup = {
  id: string
  accountId: string | null
  accountName: string | null
  direction: BankTransactionDirection
  amount: string | number
  description: string | null
  externalRef: string | null
  occurredAt: string
  status: BankTransactionStatus
  createdAt: string
}

export type FinanceInboxToday = {
  generatedAt: string
  installmentsDueToday: FinancialInstallmentLookup[]
  installmentsOverdue: FinancialInstallmentLookup[]
  pendingBankTransactions: BankTransactionLookup[]
  summary: {
    dueTodayCount: number
    overdueCount: number
    pendingBankTransactionsCount: number
    dueTodayAmount: number
    overdueAmount: number
  }
}

export async function fetchFinancialAccountsPaged(options?: {
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<LookupPageResult<FinancialAccountLookup>> {
  const params = buildLookupQueryParams(options)
  const path = params.size > 0 ? `/finance/accounts?${params.toString()}` : '/finance/accounts'
  const { data, headers } = await getJsonWithHeaders<FinancialAccountLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export async function fetchReconciliationActivity(options?: {
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<LookupPageResult<ReconciliationActivity>> {
  const params = buildLookupQueryParams(options)
  const path = params.size > 0
    ? `/finance/reconciliation/activity?${params.toString()}`
    : '/finance/reconciliation/activity'
  const { data, headers } = await getJsonWithHeaders<ReconciliationActivity[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export async function fetchFinancialTitlesPaged(options?: {
  titleType?: FinancialTitleType
  status?: FinancialStatus
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<LookupPageResult<FinancialTitleLookup>> {
  const params = buildLookupQueryParams(options)
  const path = params.size > 0 ? `/finance/titles?${params.toString()}` : '/finance/titles'
  const { data, headers } = await getJsonWithHeaders<FinancialTitleLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export async function fetchFinanceInstallmentsPaged(options?: {
  status?: FinancialStatus
  titleType?: FinancialTitleType
  customerId?: string
  supplierId?: string
  dueFrom?: string
  dueTo?: string
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<LookupPageResult<FinancialInstallmentLookup>> {
  const params = buildLookupQueryParams(options)
  const path = params.size > 0 ? `/finance/installments?${params.toString()}` : '/finance/installments'
  const { data, headers } = await getJsonWithHeaders<FinancialInstallmentLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export async function fetchBankTransactionsPaged(options?: {
  direction?: BankTransactionDirection
  status?: BankTransactionStatus
  accountId?: string
  from?: string
  to?: string
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<LookupPageResult<BankTransactionLookup>> {
  const params = buildLookupQueryParams(options)
  const path = params.size > 0
    ? `/finance/bank-transactions?${params.toString()}`
    : '/finance/bank-transactions'
  const { data, headers } = await getJsonWithHeaders<BankTransactionLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export function fetchFinanceInboxToday(options?: { limit?: number; signal?: AbortSignal }) {
  const params = buildLookupQueryParams({ limit: options?.limit })
  const path = params.size > 0 ? `/finance/inbox/today?${params.toString()}` : '/finance/inbox/today'
  return getJson<FinanceInboxToday>(path, { signal: options?.signal })
}

export function createFinancialAccount(input: {
  name: string
  bankCode?: string
  agency?: string
  accountNumber?: string
}, options?: { idempotencyKey?: string }) {
  return postJson<{ id: string }>('/finance/accounts', input, {
    headers: idempotencyHeader('finance-account-create', options?.idempotencyKey),
  })
}

export function createFinancialTitle(input: {
  titleType: FinancialTitleType
  customerId?: string
  supplierId?: string
  description?: string
  totalAmount: number
  installmentCount?: number
  firstDueDate: string
}, options?: { idempotencyKey?: string }) {
  return postJson<{ titleId: string }>('/finance/titles', input, {
    headers: idempotencyHeader('finance-title-create', options?.idempotencyKey),
  })
}

export function payInstallment(input: {
  installmentId: string
  accountId?: string
  amount: number
  method?: PaymentMethod
  paidAt?: string
}, options?: { idempotencyKey?: string }) {
  return postJson<{
    installmentId: string
    titleId: string
    titleStatus: string
    signedAmount: number
    paymentMethod: string
  }>('/finance/installments/pay', input, {
    headers: idempotencyHeader('finance-installment-pay', options?.idempotencyKey),
  })
}

export function createBankTransaction(input: {
  accountId?: string
  direction: BankTransactionDirection
  amount: number
  description?: string
  externalRef?: string
  occurredAt?: string
}, options?: { idempotencyKey?: string }) {
  return postJson<{ bankTransactionId: string }>('/finance/bank-transactions', input, {
    headers: idempotencyHeader('finance-bank-transaction-create', options?.idempotencyKey),
  })
}

export function importOfx(
  input: { accountId?: string; rawText: string },
  options?: { idempotencyKey?: string },
) {
  return postJson<{
    importId: string
    totalCount: number
    importedCount: number
    ignoredCount: number
  }>('/finance/ofx/import', input, {
    headers: idempotencyHeader('finance-ofx-import', options?.idempotencyKey),
  })
}

export function reconcileBankTransaction(input: {
  bankTransactionId: string
  installmentId?: string
}, options?: { idempotencyKey?: string }) {
  return postJson<{ reconciliationItemId: string }>('/finance/reconcile', input, {
    headers: idempotencyHeader('finance-reconcile-manual', options?.idempotencyKey),
  })
}

export function reconcileBankTransactionSettle(input: {
  bankTransactionId: string
  installmentId: string
  method?: PaymentMethod
  paidAt?: string
}, options?: { idempotencyKey?: string }) {
  return postJson<{
    reconciliationItemId: string
    installmentId: string
    titleId: string
  }>('/finance/reconcile/settle', input, {
    headers: idempotencyHeader('finance-reconcile-settle', options?.idempotencyKey),
  })
}

export function reconcileBankTransactionAdjustment(input: {
  bankTransactionId: string
  adjustmentType?: ReconciliationAdjustmentType
  description?: string
}, options?: { idempotencyKey?: string }) {
  return postJson<{
    reconciliationItemId: string
    cashFlowEntryId: string
  }>('/finance/reconcile/adjustment', input, {
    headers: idempotencyHeader('finance-reconcile-adjustment', options?.idempotencyKey),
  })
}

export function autoReconcile(
  input?: { accountId?: string; tolerance?: number },
  options?: { idempotencyKey?: string },
) {
  return postJson<{ matched: number; reconciliationId: string | null }>(
    '/finance/reconcile/auto',
    input ?? {},
    {
      headers: idempotencyHeader('finance-reconcile-auto', options?.idempotencyKey),
    },
  )
}

export function createPaymentRequest(input: {
  titleId?: string
  provider: PaymentProvider
  amount: number
  payload?: Record<string, unknown>
}, options?: { idempotencyKey?: string }) {
  return postJson<{ paymentRequestId: string }>('/finance/payment-requests', input, {
    headers: idempotencyHeader('finance-payment-request-create', options?.idempotencyKey),
  })
}

export function cancelFinancialTitle(titleId: string, options?: { idempotencyKey?: string }) {
  return postJson<{ titleId: string; status: string }>(`/finance/titles/${titleId}/cancel`, {}, {
    headers: idempotencyHeader('finance-title-cancel', options?.idempotencyKey),
  })
}

export function updateFinancialTitle(titleId: string, input: {
  description?: string
  costCenter?: string
}, options?: { idempotencyKey?: string }) {
  return postJson<{ titleId: string; updated: boolean }>(`/finance/titles/${titleId}/update`, input, {
    headers: idempotencyHeader('finance-title-update', options?.idempotencyKey),
  })
}

export function reverseInstallment(installmentId: string, options?: { idempotencyKey?: string }) {
  return postJson<{ installmentId: string; reversed: boolean }>('/finance/installments/reverse', {
    installmentId,
  }, {
    headers: idempotencyHeader('finance-installment-reverse', options?.idempotencyKey),
  })
}

export async function fetchInstallments(titleId: string) {
  return getJson<Array<{
    id: string
    due_date: string
    amount: number
    paid_at: string | null
    status: FinancialStatus
    title_type: FinancialTitleType
  }>>(
    `/finance/titles/${titleId}/installments`,
  )
}
