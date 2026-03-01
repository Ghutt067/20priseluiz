import { Router } from 'express'
import { pool } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser } from './authMiddleware'

const router = Router()

router.get('/dashboard/all', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const memberCheck = await pool.query(
      'select 1 from organization_users where organization_id = $1 and user_id = $2 limit 1',
      [organizationId, user.id],
    )
    if ((memberCheck.rowCount ?? 0) === 0) {
      throw new Error('Usuário autenticado sem acesso à organização informada.')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const safe = (promise: Promise<{ rows: any[] }>): Promise<{ rows: any[] }> =>
      promise.catch(() => ({ rows: [] }))

    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString()

    const [
      salesToday, pendingPurchases, overdueReceivables, lowStock, activeContracts,
      lowStockRows, overdueRows, appointmentsRows,
      salesByDay, dreData, topProducts,
      activityRows,
    ] = await Promise.all([
      safe(pool.query(
        `select coalesce(count(*), 0)::int as count, coalesce(sum(total_amount), 0)::numeric as revenue
         from sales_orders where organization_id = $1 and created_at >= $2::timestamptz and status != 'cancelled'`,
        [organizationId, startOfDay],
      )),
      safe(pool.query(
        `select coalesce(count(*), 0)::int as count from purchase_orders
         where organization_id = $1 and status in ('draft', 'approved')`,
        [organizationId],
      )),
      safe(pool.query(
        `select coalesce(count(*), 0)::int as count, coalesce(sum(fi.amount), 0)::numeric as total
         from financial_installments fi join financial_titles ft on ft.id = fi.title_id
         where fi.organization_id = $1 and ft.title_type = 'receivable' and fi.status = 'open' and fi.due_date < current_date`,
        [organizationId],
      )),
      safe(pool.query(
        `select coalesce(count(distinct sl.product_id), 0)::int as count from stock_levels sl
         where sl.organization_id = $1 and sl.min_qty > 0 and sl.qty_available < sl.min_qty`,
        [organizationId],
      )),
      safe(pool.query(
        `select coalesce(count(*), 0)::int as count from contracts
         where organization_id = $1 and status = 'active'`,
        [organizationId],
      )),
      safe(pool.query(
        `select p.id as product_id, p.name as product_name, p.sku, w.name as warehouse_name,
                sl.qty_available::numeric as qty_available, sl.min_qty::numeric as min_qty
         from stock_levels sl join products p on p.id = sl.product_id join warehouses w on w.id = sl.warehouse_id
         where sl.organization_id = $1 and sl.min_qty > 0 and sl.qty_available < sl.min_qty
         order by (sl.qty_available::numeric / nullif(sl.min_qty::numeric, 0)) asc limit 10`,
        [organizationId],
      )),
      safe(pool.query(
        `select ft.id as title_id, ft.description, ft.title_type, fi.due_date, fi.amount::numeric as amount,
                coalesce(c.name, s.name, '') as party_name
         from financial_installments fi join financial_titles ft on ft.id = fi.title_id
         left join customers c on c.id = ft.customer_id left join suppliers s on s.id = ft.supplier_id
         where fi.organization_id = $1 and fi.status = 'open' and fi.due_date < current_date
         order by fi.due_date asc limit 10`,
        [organizationId],
      )),
      safe(pool.query(
        `select a.id, a.subject, a.scheduled_at, coalesce(c.name, '') as customer_name
         from appointments a left join customers c on c.id = a.customer_id
         where a.organization_id = $1 and a.status = 'scheduled' and a.scheduled_at::date = current_date
         order by a.scheduled_at asc limit 10`,
        [organizationId],
      )),
      safe(pool.query(
        `select date_trunc('day', created_at at time zone 'America/Sao_Paulo')::date as day,
                coalesce(sum(total_amount), 0)::numeric as revenue, coalesce(count(*), 0)::int as count
         from sales_orders where organization_id = $1 and status != 'cancelled' and created_at >= now() - interval '7 days'
         group by 1 order by 1 asc`,
        [organizationId],
      )),
      safe(pool.query(
        `select ft.title_type, coalesce(sum(fi.amount), 0)::numeric as total
         from financial_installments fi join financial_titles ft on ft.id = fi.title_id
         where fi.organization_id = $1 and fi.status = 'paid' and fi.paid_at >= date_trunc('month', current_date)
         group by ft.title_type`,
        [organizationId],
      )),
      safe(pool.query(
        `select p.id, p.name, sum(soi.quantity)::numeric as qty_sold, sum(soi.quantity * soi.unit_price)::numeric as revenue
         from sales_order_items soi join products p on p.id = soi.product_id
         join sales_orders so on so.id = soi.sales_order_id
         where soi.organization_id = $1 and so.status != 'cancelled' and so.created_at >= date_trunc('month', current_date)
         group by p.id, p.name order by revenue desc limit 5`,
        [organizationId],
      )),
      safe(pool.query(
        `select al.id, al.operation, al.table_name, al.record_id, al.new_data, al.created_at,
                coalesce(p.full_name, p.email, al.actor_user_id::text) as actor_name
         from audit_log al left join profiles p on p.id = al.actor_user_id
         where al.organization_id = $1 order by al.created_at desc limit 15`,
        [organizationId],
      )),
    ])

    const dre: Record<string, number> = {}
    for (const row of dreData.rows) {
      dre[row.title_type] = Number(row.total)
    }

    const result = {
      summary: {
        salesToday: { count: salesToday.rows[0]?.count ?? 0, revenue: Number(salesToday.rows[0]?.revenue ?? 0) },
        pendingPurchases: pendingPurchases.rows[0]?.count ?? 0,
        overdueReceivables: { count: overdueReceivables.rows[0]?.count ?? 0, total: Number(overdueReceivables.rows[0]?.total ?? 0) },
        lowStockProducts: lowStock.rows[0]?.count ?? 0,
        activeContracts: activeContracts.rows[0]?.count ?? 0,
      },
      alerts: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lowStock: lowStockRows.rows.map((r: any) => ({
          productId: r.product_id, productName: r.product_name, sku: r.sku,
          warehouseName: r.warehouse_name, qtyAvailable: Number(r.qty_available), minQty: Number(r.min_qty),
        })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        overduePayments: overdueRows.rows.map((r: any) => ({
          titleId: r.title_id, description: r.description, titleType: r.title_type,
          dueDate: r.due_date, amount: Number(r.amount), partyName: r.party_name,
        })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        todayAppointments: appointmentsRows.rows.map((r: any) => ({
          id: r.id, subject: r.subject, scheduledAt: r.scheduled_at, customerName: r.customer_name,
        })),
      },
      charts: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        salesByDay: salesByDay.rows.map((r: any) => ({ day: r.day, revenue: Number(r.revenue), count: Number(r.count) })),
        dreMonth: { receitas: dre['receivable'] ?? 0, despesas: dre['payable'] ?? 0 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        topProducts: topProducts.rows.map((r: any) => ({ id: r.id, name: r.name, qtySold: Number(r.qty_sold), revenue: Number(r.revenue) })),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      activity: activityRows.rows.map((r: any) => ({
        id: r.id, operation: r.operation, tableName: r.table_name, recordId: r.record_id,
        summary: buildActivitySummary(r.operation, r.table_name, r.new_data),
        actorName: r.actor_name, createdAt: r.created_at,
      })),
    }

    response.json(result)
  } catch (error) {
    console.error('[dashboard/all] ERROR', error)
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

function buildActivitySummary(
  operation: string,
  tableName: string,
  newData: Record<string, unknown> | null,
): string {
  const tableLabels: Record<string, string> = {
    sales_orders: 'Pedido de venda',
    purchase_orders: 'Pedido de compra',
    purchase_receipts: 'Recebimento',
    invoices: 'Fatura',
    fiscal_documents: 'Documento fiscal',
    financial_titles: 'Título financeiro',
    stock_transfers: 'Transferência de estoque',
    inventory_counts: 'Inventário',
    return_orders: 'Devolução',
    service_orders: 'Ordem de serviço',
    promotions: 'Promoção',
    shipments: 'Expedição',
    customers: 'Cliente',
    suppliers: 'Fornecedor',
    products: 'Produto',
    employees: 'Funcionário',
  }

  const label = tableLabels[tableName] ?? tableName
  const opLabels: Record<string, string> = {
    insert: 'criado',
    update: 'atualizado',
    delete: 'removido',
  }
  const opLabel = opLabels[operation] ?? operation

  let detail = ''
  if (newData) {
    if (typeof newData.totalAmount === 'number') {
      detail = ` — R$ ${newData.totalAmount.toFixed(2)}`
    } else if (typeof newData.name === 'string') {
      detail = ` — ${newData.name}`
    }
  }

  return `${label} ${opLabel}${detail}`
}

export { router as dashboardRoutes }
