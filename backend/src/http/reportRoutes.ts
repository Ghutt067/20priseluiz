import { Router } from 'express'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'

const router = Router()

const TITLE_TYPE_VALUES = ['receivable', 'payable'] as const
const AGING_BUCKET_VALUES = ['overdue', 'due_0_30', 'due_31_60', 'due_60_plus'] as const

function normalizeOptionalQueryValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function isAllowedValue<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return (allowed as readonly string[]).includes(value)
}

function parseLimitOffset(
  query: Record<string, unknown>,
  defaults?: {
    limit?: number
    maxLimit?: number
  },
) {
  const parsedLimit = Number.parseInt(typeof query.limit === 'string' ? query.limit : '', 10)
  const parsedOffset = Number.parseInt(typeof query.offset === 'string' ? query.offset : '', 10)
  const maxLimit = Math.max(defaults?.maxLimit ?? 200, 1)
  const fallbackLimit = Math.min(Math.max(defaults?.limit ?? 30, 1), maxLimit)
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), maxLimit)
    : fallbackLimit
  const offset = Number.isFinite(parsedOffset)
    ? Math.max(parsedOffset, 0)
    : 0
  return { limit, offset }
}

router.get('/reports/cashflow', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const accountId = normalizeOptionalQueryValue(request.query.accountId)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select date_trunc('month', cfe.entry_date::timestamp)::date as month,
                sum(amount) as total
         from cash_flow_entries cfe
         where cfe.organization_id = $1
           and ($2 = '' or cfe.entry_date >= $2::date)
           and ($3 = '' or cfe.entry_date <= $3::date)
           and ($4 = '' or cfe.account_id::text = $4)
         group by month
         order by month desc`,
        [organizationId, from, to, accountId],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/cashflow/entries', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const accountId = normalizeOptionalQueryValue(request.query.accountId)
    const month = normalizeOptionalQueryValue(request.query.month)
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 40,
      maxLimit: 200,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from cash_flow_entries cfe
         where cfe.organization_id = $1
           and ($2 = '' or cfe.entry_date >= $2::date)
           and ($3 = '' or cfe.entry_date <= $3::date)
           and ($4 = '' or cfe.account_id::text = $4)
           and ($5 = '' or to_char(cfe.entry_date, 'YYYY-MM') = to_char($5::date, 'YYYY-MM'))`,
        [organizationId, from, to, accountId, month],
      )

      const rowsResult = await client.query(
        `select
           cfe.id,
           cfe.entry_date as "entryDate",
           cfe.amount,
           cfe.description,
           cfe.account_id as "accountId",
           fa.name as "accountName",
           cfe.title_id as "titleId",
           ft.title_type as "titleType"
         from cash_flow_entries cfe
         left join financial_accounts fa
           on fa.id = cfe.account_id
          and fa.organization_id = cfe.organization_id
         left join financial_titles ft
           on ft.id = cfe.title_id
          and ft.organization_id = cfe.organization_id
         where cfe.organization_id = $1
           and ($2 = '' or cfe.entry_date >= $2::date)
           and ($3 = '' or cfe.entry_date <= $3::date)
           and ($4 = '' or cfe.account_id::text = $4)
           and ($5 = '' or to_char(cfe.entry_date, 'YYYY-MM') = to_char($5::date, 'YYYY-MM'))
         order by cfe.entry_date desc, cfe.created_at desc, cfe.id desc
         limit $6
         offset $7`,
        [organizationId, from, to, accountId, month, limit, offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json({ rows: result.rows, totalCount: Math.max(result.total, 0) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/dre', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select title_type,
                sum(total_amount) as total
         from financial_titles
         where organization_id = $1
           and ($2 = '' or created_at::date >= $2::date)
           and ($3 = '' or created_at::date <= $3::date)
         group by title_type`,
        [organizationId, from, to],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/sales', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select date_trunc('month', created_at)::date as month,
                sum(total_amount) as total
         from sales_orders
         where organization_id = $1
           and ($2 = '' or created_at::date >= $2::date)
           and ($3 = '' or created_at::date <= $3::date)
         group by month
         order by month desc`,
        [organizationId, from, to],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/top-customers', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select c.id, c.name, sum(so.total_amount) as total
         from sales_orders so
         join customers c
           on c.id = so.customer_id
          and c.organization_id = so.organization_id
         where so.organization_id = $1
           and ($2 = '' or so.created_at::date >= $2::date)
           and ($3 = '' or so.created_at::date <= $3::date)
         group by c.id, c.name
         order by total desc
         limit 10`,
        [organizationId, from, to],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/inventory-value', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select sum(sl.qty_available * p.cost) as total_value
         from stock_levels sl
         join products p on p.id = sl.product_id
         where sl.organization_id = $1`,
        [organizationId],
      ),
    )
    response.json(result.rows[0] ?? { total_value: 0 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/margin-by-product', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select p.id,
                p.name,
                sum(soi.quantity) as qty_sold,
                sum(soi.total_price) as revenue,
                sum(soi.quantity * p.cost) as cost,
                sum(soi.total_price) - sum(soi.quantity * p.cost) as margin
         from sales_order_items soi
         join products p on p.id = soi.product_id
         join sales_orders so on so.id = soi.sales_order_id
         where soi.organization_id = $1
           and ($2 = '' or so.created_at::date >= $2::date)
           and ($3 = '' or so.created_at::date <= $3::date)
         group by p.id, p.name
         order by margin desc
         limit 20`,
        [organizationId, from, to],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/inventory-turnover', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select p.id,
                p.name,
                coalesce(sold.qty_sold, 0) as qty_sold,
                avg(coalesce(sl.qty_available, 0)) as avg_stock
         from products p
         left join (
           select soi.organization_id,
                  soi.product_id,
                  sum(soi.quantity) as qty_sold
           from sales_order_items soi
           join sales_orders so
             on so.organization_id = soi.organization_id
            and so.id = soi.sales_order_id
           where soi.organization_id = $1
             and ($2 = '' or so.created_at::date >= $2::date)
             and ($3 = '' or so.created_at::date <= $3::date)
           group by soi.organization_id, soi.product_id
         ) sold
           on sold.organization_id = p.organization_id
          and sold.product_id = p.id
         left join stock_levels sl
           on sl.organization_id = p.organization_id
          and sl.product_id = p.id
         where p.organization_id = $1
         group by p.id, p.name, sold.qty_sold
         order by qty_sold desc`,
        [organizationId, from, to],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/commissions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select a.id, a.name, sum(c.amount) as total, c.status
         from sales_commissions c
         join sales_agents a on a.id = c.agent_id
         where c.organization_id = $1
           and ($2 = '' or c.created_at::date >= $2::date)
           and ($3 = '' or c.created_at::date <= $3::date)
         group by a.id, a.name, c.status
         order by total desc`,
        [organizationId, from, to],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/aging', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const titleTypeRaw = normalizeOptionalQueryValue(request.query.titleType)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const titleType = isAllowedValue(titleTypeRaw, TITLE_TYPE_VALUES) ? titleTypeRaw : ''
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select
           coalesce(sum(case when fi.due_date < current_date then fi.amount else 0 end), 0) as overdue,
           coalesce(sum(case when fi.due_date between current_date and current_date + interval '30 day' then fi.amount else 0 end), 0) as due_0_30,
           coalesce(sum(case when fi.due_date between current_date + interval '31 day' and current_date + interval '60 day' then fi.amount else 0 end), 0) as due_31_60,
           coalesce(sum(case when fi.due_date > current_date + interval '60 day' then fi.amount else 0 end), 0) as due_60_plus
         from financial_installments fi
         join financial_titles ft
           on ft.organization_id = fi.organization_id
          and ft.id = fi.title_id
         where fi.organization_id = $1
           and fi.status = 'open'
           and ($2 = '' or ft.title_type::text = $2)
           and ($3 = '' or fi.due_date >= $3::date)
           and ($4 = '' or fi.due_date <= $4::date)`,
        [organizationId, titleType, from, to],
      ),
    )
    response.json(result.rows[0] ?? {
      overdue: 0,
      due_0_30: 0,
      due_31_60: 0,
      due_60_plus: 0,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/reports/aging/entries', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const titleTypeRaw = normalizeOptionalQueryValue(request.query.titleType)
    const bucketRaw = normalizeOptionalQueryValue(request.query.bucket)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const titleType = isAllowedValue(titleTypeRaw, TITLE_TYPE_VALUES) ? titleTypeRaw : ''
    const bucket = isAllowedValue(bucketRaw, AGING_BUCKET_VALUES) ? bucketRaw : ''
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 40,
      maxLimit: 200,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from financial_installments fi
         join financial_titles ft
           on ft.organization_id = fi.organization_id
          and ft.id = fi.title_id
         where fi.organization_id = $1
           and fi.status = 'open'
           and ($2 = '' or ft.title_type::text = $2)
           and ($3 = '' or fi.due_date >= $3::date)
           and ($4 = '' or fi.due_date <= $4::date)
           and (
             $5 = ''
             or ($5 = 'overdue' and fi.due_date < current_date)
             or ($5 = 'due_0_30' and fi.due_date between current_date and current_date + interval '30 day')
             or ($5 = 'due_31_60' and fi.due_date between current_date + interval '31 day' and current_date + interval '60 day')
             or ($5 = 'due_60_plus' and fi.due_date > current_date + interval '60 day')
           )`,
        [organizationId, titleType, from, to, bucket],
      )

      const rowsResult = await client.query(
        `select
           fi.id,
           fi.title_id as "titleId",
           fi.due_date as "dueDate",
           fi.amount,
           ft.title_type as "titleType",
           ft.description as "titleDescription",
           c.name as "customerName",
           s.name as "supplierName",
           case
             when fi.due_date < current_date then 'overdue'
             when fi.due_date between current_date and current_date + interval '30 day' then 'due_0_30'
             when fi.due_date between current_date + interval '31 day' and current_date + interval '60 day' then 'due_31_60'
             else 'due_60_plus'
           end as bucket
         from financial_installments fi
         join financial_titles ft
           on ft.organization_id = fi.organization_id
          and ft.id = fi.title_id
         left join customers c
           on c.organization_id = ft.organization_id
          and c.id = ft.customer_id
         left join suppliers s
           on s.organization_id = ft.organization_id
          and s.id = ft.supplier_id
         where fi.organization_id = $1
           and fi.status = 'open'
           and ($2 = '' or ft.title_type::text = $2)
           and ($3 = '' or fi.due_date >= $3::date)
           and ($4 = '' or fi.due_date <= $4::date)
           and (
             $5 = ''
             or ($5 = 'overdue' and fi.due_date < current_date)
             or ($5 = 'due_0_30' and fi.due_date between current_date and current_date + interval '30 day')
             or ($5 = 'due_31_60' and fi.due_date between current_date + interval '31 day' and current_date + interval '60 day')
             or ($5 = 'due_60_plus' and fi.due_date > current_date + interval '60 day')
           )
         order by fi.due_date asc, fi.id asc
         limit $6
         offset $7`,
        [organizationId, titleType, from, to, bucket, limit, offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json({ rows: result.rows, totalCount: Math.max(result.total, 0) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export { router as reportRoutes }
