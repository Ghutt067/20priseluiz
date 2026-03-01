import { getJson } from './http'

export type DashboardSummary = {
  salesToday: { count: number; revenue: number }
  pendingPurchases: number
  overdueReceivables: { count: number; total: number }
  lowStockProducts: number
  activeContracts: number
}

export type LowStockAlert = {
  productId: string
  productName: string
  sku: string | null
  warehouseName: string
  qtyAvailable: number
  minQty: number
}

export type OverduePaymentAlert = {
  titleId: string
  description: string | null
  titleType: string
  dueDate: string
  amount: number
  partyName: string
}

export type TodayAppointment = {
  id: string
  subject: string
  scheduledAt: string
  customerName: string
}

export type DashboardAlerts = {
  lowStock: LowStockAlert[]
  overduePayments: OverduePaymentAlert[]
  todayAppointments: TodayAppointment[]
}

export type ActivityEntry = {
  id: string
  operation: string
  tableName: string
  recordId: string | null
  summary: string
  actorName: string
  createdAt: string
}

export type DashboardCharts = {
  salesByDay: Array<{ day: string; revenue: number; count: number }>
  dreMonth: { receitas: number; despesas: number }
  topProducts: Array<{ id: string; name: string; qtySold: number; revenue: number }>
}

export type DashboardAll = {
  summary: DashboardSummary
  alerts: DashboardAlerts
  charts: DashboardCharts
  activity: ActivityEntry[]
}

export function fetchDashboardAll() {
  return getJson<DashboardAll>('/dashboard/all')
}
