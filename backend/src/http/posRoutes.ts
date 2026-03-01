import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { closePosSession } from '../use-cases/pos/closePosSession'
import { createPosSale } from '../use-cases/pos/createPosSale'

const router = Router()


router.post('/pos/sessions/:id/close', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      closePosSession(client, { organizationId, sessionId: request.params.id }),
    )

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/pos/sales', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      posSessionId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
      items: z.array(
        z.object({
          product_id: z.string().uuid().optional(),
          quantity: z.number().positive(),
          unit_price: z.number().nonnegative(),
        }),
      ),
      payments: z.array(
        z.object({
          method: z.string().min(1),
          amount: z.number().positive(),
        }),
      ),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      createPosSale(client, {
        organizationId,
        posSessionId: data.posSessionId ?? null,
        customerId: data.customerId ?? null,
        items: data.items,
        payments: data.payments,
      }),
    )

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/pos/sessions/current', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)

    const result = await withOrgRead(organizationId, async (client) => {
      const sessionResult = await client.query(
        `select id as "sessionId", cashier_id as "cashierId", opened_at as "openedAt"
         from pos_sessions
         where organization_id = $1
           and status = 'open'
         order by opened_at desc
         limit 1`,
        [organizationId],
      )
      if ((sessionResult.rowCount ?? 0) === 0) return null
      return sessionResult.rows[0]
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/pos/sessions/:id/sales', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)

    const result = await withOrgRead(organizationId, async (client) => {
      const salesResult = await client.query(
        `select
           ps.id as "posSaleId",
           ps.total_amount::numeric as "totalAmount",
           ps.created_at as "createdAt",
           coalesce(c.name, '') as "customerName"
         from pos_sales ps
         left join customers c on c.id = ps.customer_id
         where ps.organization_id = $1
           and ps.pos_session_id = $2
         order by ps.created_at desc
         limit 50`,
        [organizationId, request.params.id],
      )
      return salesResult.rows.map((r) => ({
        ...r,
        totalAmount: Number(r.totalAmount),
      }))
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/pos/sessions/:id/summary', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)

    const result = await withOrgRead(organizationId, async (client) => {
      const summaryResult = await client.query(
        `select
           coalesce(count(*), 0)::int as "salesCount",
           coalesce(sum(total_amount), 0)::numeric as "totalRevenue"
         from pos_sales
         where organization_id = $1
           and pos_session_id = $2`,
        [organizationId, request.params.id],
      )
      const row = summaryResult.rows[0]
      return {
        salesCount: row?.salesCount ?? 0,
        totalRevenue: Number(row?.totalRevenue ?? 0),
      }
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/pos/sessions/open', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      cashierId: z.string().uuid().optional(),
      openingAmount: z.number().nonnegative().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      const sessionResult = await client.query(
        `insert into pos_sessions (organization_id, cashier_id, status, opening_amount)
         values ($1, $2, 'open', $3) returning id as "sessionId"`,
        [organizationId, data.cashierId ?? null, data.openingAmount ?? 0],
      )
      const sessionId = sessionResult.rows[0].sessionId as string

      if ((data.openingAmount ?? 0) > 0) {
        await client.query(
          `insert into pos_cash_movements (organization_id, session_id, movement_type, amount, notes)
           values ($1, $2, 'fundo', $3, 'Fundo de caixa inicial')`,
          [organizationId, sessionId, data.openingAmount],
        )
      }
      return { sessionId }
    })
    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/pos/sessions/:id/sangria', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ amount: z.number().positive(), notes: z.string().optional() })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      const session = await client.query(
        `select id from pos_sessions where organization_id = $1 and id = $2 and status = 'open'`,
        [organizationId, request.params.id],
      )
      if ((session.rowCount ?? 0) === 0) throw new Error('Sessão não encontrada ou não está aberta.')

      const row = await client.query(
        `insert into pos_cash_movements (organization_id, session_id, movement_type, amount, notes)
         values ($1, $2, 'sangria', $3, $4) returning id`,
        [organizationId, request.params.id, data.amount, data.notes ?? null],
      )
      return { id: row.rows[0].id }
    })
    response.status(201).json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/pos/sessions/:id/reforco', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ amount: z.number().positive(), notes: z.string().optional() })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      const session = await client.query(
        `select id from pos_sessions where organization_id = $1 and id = $2 and status = 'open'`,
        [organizationId, request.params.id],
      )
      if ((session.rowCount ?? 0) === 0) throw new Error('Sessão não encontrada ou não está aberta.')

      const row = await client.query(
        `insert into pos_cash_movements (organization_id, session_id, movement_type, amount, notes)
         values ($1, $2, 'reforco', $3, $4) returning id`,
        [organizationId, request.params.id, data.amount, data.notes ?? null],
      )
      return { id: row.rows[0].id }
    })
    response.status(201).json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/pos/sessions/:id/report', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)

    const result = await withOrgRead(organizationId, async (client) => {
      const sessionRow = await client.query(
        `select id, opening_amount::numeric as "openingAmount", closing_amount::numeric as "closingAmount",
                opened_at as "openedAt", closed_at as "closedAt", status
         from pos_sessions where organization_id = $1 and id = $2`,
        [organizationId, request.params.id],
      )
      if ((sessionRow.rowCount ?? 0) === 0) throw new Error('Sessão não encontrada.')
      const session = sessionRow.rows[0]

      const byMethod = await client.query(
        `select sp.method, sum(sp.amount)::numeric as total, count(*)::int as count
         from pos_sale_payments sp
         join pos_sales ps on ps.id = sp.pos_sale_id
         where ps.organization_id = $1 and ps.pos_session_id = $2
         group by sp.method`,
        [organizationId, request.params.id],
      )

      const totals = await client.query(
        `select coalesce(count(*), 0)::int as "salesCount",
                coalesce(sum(total_amount), 0)::numeric as "totalRevenue"
         from pos_sales where organization_id = $1 and pos_session_id = $2`,
        [organizationId, request.params.id],
      )

      const movements = await client.query(
        `select movement_type as "type", sum(amount)::numeric as total
         from pos_cash_movements where organization_id = $1 and session_id = $2
         group by movement_type`,
        [organizationId, request.params.id],
      )

      const movMap: Record<string, number> = {}
      for (const m of movements.rows) { movMap[m.type] = Number(m.total) }

      const cashSales = Number(byMethod.rows.find((r: Record<string, unknown>) => r.method === 'cash')?.total ?? 0)
      const expectedCash = Number(session.openingAmount ?? 0) + cashSales - (movMap['sangria'] ?? 0) + (movMap['reforco'] ?? 0)

      return {
        sessionId: request.params.id,
        status: session.status,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        openingAmount: Number(session.openingAmount ?? 0),
        closingAmount: session.closingAmount ? Number(session.closingAmount) : null,
        salesCount: totals.rows[0]?.salesCount ?? 0,
        totalRevenue: Number(totals.rows[0]?.totalRevenue ?? 0),
        byMethod: byMethod.rows.map((r: Record<string, unknown>) => ({
          method: r.method,
          total: Number(r.total),
          count: r.count,
        })),
        movements: movements.rows.map((m: Record<string, unknown>) => ({ type: m.type, total: Number(m.total) })),
        expectedCash,
      }
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/pos/sessions/:id/close-with-report', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ closingAmount: z.number().nonnegative().optional() })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      const updated = await client.query(
        `update pos_sessions set status = 'closed', closing_amount = $3, closed_at = now()
         where organization_id = $1 and id = $2 and status = 'open' returning id`,
        [organizationId, request.params.id, data.closingAmount ?? null],
      )
      if ((updated.rowCount ?? 0) === 0) throw new Error('Sessão não encontrada ou já fechada.')
      return { sessionId: request.params.id }
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/pos/sales/:saleId/cancel', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const { saleId } = request.params

    const result = await withOrgTransaction(organizationId, async (client) => {
      const saleRow = await client.query(
        `select id, pos_session_id as "posSessionId", total_amount::numeric as "totalAmount", status
         from pos_sales
         where organization_id = $1 and id = $2`,
        [organizationId, saleId],
      )
      if ((saleRow.rowCount ?? 0) === 0) throw new Error('Venda não encontrada.')
      const sale = saleRow.rows[0]
      if (sale.status === 'cancelled') throw new Error('Venda já cancelada.')

      await client.query(
        `update pos_sales set status = 'cancelled', cancelled_at = now()
         where organization_id = $1 and id = $2`,
        [organizationId, saleId],
      )

      const itemsResult = await client.query(
        `select product_id, quantity from pos_sale_items
         where pos_sale_id = $1 and product_id is not null`,
        [saleId],
      )
      for (const item of itemsResult.rows) {
        await client.query(
          `update stock_levels set qty_available = qty_available + $3
           where organization_id = $1 and product_id = $2`,
          [organizationId, item.product_id, item.quantity],
        )
      }

      return { saleId, cancelled: true, totalAmount: Number(sale.totalAmount) }
    })

    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

export { router as posRoutes }
