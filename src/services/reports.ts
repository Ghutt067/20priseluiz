import { getJson } from './http'

type BasePeriodFilter = {
  from?: string
  to?: string
}

type AccountPeriodFilter = BasePeriodFilter & {
  accountId?: string
}

function buildReportQuery(
  filters?: Record<string, string | number | null | undefined>,
) {
  const params = new URLSearchParams()

  if (!filters) return params

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      const normalized = value.trim()
      if (!normalized) continue
      params.set(key, normalized)
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      params.set(key, String(value))
    }
  }

  return params
}

function withQuery(path: string, filters?: Record<string, string | number | null | undefined>) {
  const params = buildReportQuery(filters)
  if (params.size === 0) return path
  return `${path}?${params.toString()}`
}

export type CashflowReportRow = {
  month: string
  total: string | number
}

export type CashflowEntryReportRow = {
  id: string
  entryDate: string
  amount: string | number
  description: string | null
  accountId: string | null
  accountName: string | null
  titleId: string | null
  titleType: 'receivable' | 'payable' | null
}

export type AgingBucket = 'overdue' | 'due_0_30' | 'due_31_60' | 'due_60_plus'

export type AgingEntryReportRow = {
  id: string
  titleId: string
  dueDate: string
  amount: string | number
  titleType: 'receivable' | 'payable'
  titleDescription: string | null
  customerName: string | null
  supplierName: string | null
  bucket: AgingBucket
}

export function fetchCashflowReport(filters?: AccountPeriodFilter) {
  return getJson<CashflowReportRow[]>(withQuery('/reports/cashflow', filters))
}

export function fetchCashflowEntriesReport(filters?:
  AccountPeriodFilter & {
    month?: string
    limit?: number
    offset?: number
  },
) {
  return getJson<{
    rows: CashflowEntryReportRow[]
    totalCount: number
  }>(withQuery('/reports/cashflow/entries', filters))
}

export function fetchDreReport(filters?: BasePeriodFilter) {
  return getJson<Array<{ title_type: string; total: string | number }>>(
    withQuery('/reports/dre', filters),
  )
}

export function fetchSalesReport(filters?: BasePeriodFilter) {
  return getJson<Array<{ month: string; total: string | number }>>(
    withQuery('/reports/sales', filters),
  )
}

export function fetchTopCustomers(filters?: BasePeriodFilter) {
  return getJson<Array<{ id: string; name: string; total: string | number }>>(
    withQuery('/reports/top-customers', filters),
  )
}

export function fetchInventoryValue() {
  return getJson<{ total_value: string | number }>('/reports/inventory-value')
}

export function fetchMarginByProduct(filters?: BasePeriodFilter) {
  return getJson<
    Array<{
      id: string
      name: string
      qty_sold: string | number
      revenue: string | number
      cost: string | number
      margin: string | number
    }>
  >(withQuery('/reports/margin-by-product', filters))
}

export function fetchInventoryTurnover(filters?: BasePeriodFilter) {
  return getJson<
    Array<{
      id: string
      name: string
      qty_sold: string | number
      avg_stock: string | number
    }>
  >(withQuery('/reports/inventory-turnover', filters))
}

export function fetchCommissionsReport(filters?: BasePeriodFilter) {
  return getJson<Array<{ id: string; name: string; total: string | number; status: string }>>(
    withQuery('/reports/commissions', filters),
  )
}

export function fetchAgingReport(filters?: BasePeriodFilter & { titleType?: 'receivable' | 'payable' }) {
  return getJson<{
    overdue: string | number
    due_0_30: string | number
    due_31_60: string | number
    due_60_plus: string | number
  }>(withQuery('/reports/aging', filters))
}

export function fetchAgingEntriesReport(filters?:
  BasePeriodFilter & {
    titleType?: 'receivable' | 'payable'
    bucket?: AgingBucket
    limit?: number
    offset?: number
  },
) {
  return getJson<{
    rows: AgingEntryReportRow[]
    totalCount: number
  }>(withQuery('/reports/aging/entries', filters))
}
