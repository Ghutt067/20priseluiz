import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { createCommissionFromOrder } from '../use-cases/sales/createCommissionFromOrder'

const router = Router()

router.get('/people/employees', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const query = ((request.query.query as string) || '').trim()
    const status = ((request.query.status as string) || '').trim()
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const conditions = ['organization_id = $1']
      const values: unknown[] = [organizationId]
      let idx = 2
      if (query) { conditions.push(`name ilike $${idx++}`); values.push(`%${query}%`) }
      if (status) { conditions.push(`status = $${idx++}`); values.push(status) }
      values.push(limit)
      const rows = await client.query(
        `select id, name, role, email, phone, status, created_at as "createdAt"
         from employees where ${conditions.join(' and ')}
         order by created_at desc limit $${idx}`,
        values,
      )
      return rows.rows
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/people/agents', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select sa.id, sa.name, sa.commission_rate::numeric as "commissionRate", sa.active,
                coalesce(e.name, '') as "employeeName"
         from sales_agents sa
         left join employees e on e.id = sa.employee_id
         where sa.organization_id = $1
         order by sa.created_at desc limit $2`,
        [organizationId, limit],
      )
      return rows.rows.map((r: Record<string, unknown>) => ({ ...r, commissionRate: Number(r.commissionRate) }))
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/people/commissions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const agentId = ((request.query.agentId as string) || '').trim()
    const statusFilter = ((request.query.status as string) || '').trim()
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const conditions = ['sc.organization_id = $1']
      const values: unknown[] = [organizationId]
      let idx = 2
      if (agentId) { conditions.push(`sc.agent_id = $${idx++}::uuid`); values.push(agentId) }
      if (statusFilter) { conditions.push(`sc.status = $${idx++}`); values.push(statusFilter) }
      values.push(limit)
      const rows = await client.query(
        `select sc.id, sc.amount::numeric as amount, sc.status, sc.created_at as "createdAt",
                coalesce(sa.name, '') as "agentName"
         from sales_commissions sc
         left join sales_agents sa on sa.id = sc.agent_id
         where ${conditions.join(' and ')}
         order by sc.created_at desc limit $${idx}`,
        values,
      )
      return rows.rows.map((r: Record<string, unknown>) => ({ ...r, amount: Number(r.amount) }))
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/loans', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const statusFilter = ((request.query.status as string) || '').trim()
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const conditions = ['lo.organization_id = $1']
      const values: unknown[] = [organizationId]
      let idx = 2
      if (statusFilter) { conditions.push(`lo.status = $${idx++}`); values.push(statusFilter) }
      values.push(limit)
      const rows = await client.query(
        `select lo.id, lo.status, lo.expected_return_date as "expectedReturnDate", lo.notes,
                lo.created_at as "createdAt", coalesce(c.name, '') as "customerName",
                (select count(*)::int from loan_items li where li.loan_order_id = lo.id) as "itemCount"
         from loan_orders lo
         left join customers c on c.id = lo.customer_id
         where ${conditions.join(' and ')}
         order by lo.created_at desc limit $${idx}`,
        values,
      )
      return rows.rows
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/people/employees', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      name: z.string().min(1),
      role: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into employees
          (organization_id, name, role, email, phone, status)
         values ($1, $2, $3, $4, $5, 'active')
         returning id`,
        [
          organizationId,
          data.name,
          data.role ?? null,
          data.email ?? null,
          data.phone ?? null,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/people/agents', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      employeeId: z.string().uuid().optional(),
      name: z.string().min(1),
      commissionRate: z.number().nonnegative(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into sales_agents
          (organization_id, employee_id, name, commission_rate, active)
         values ($1, $2, $3, $4, true)
         returning id`,
        [
          organizationId,
          data.employeeId ?? null,
          data.name,
          data.commissionRate,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/people/commissions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      salesOrderId: z.string().uuid().optional(),
      agentId: z.string().uuid().optional(),
      amount: z.number().nonnegative(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into sales_commissions
          (organization_id, sales_order_id, agent_id, amount, status)
         values ($1, $2, $3, $4, 'pending')
         returning id`,
        [
          organizationId,
          data.salesOrderId ?? null,
          data.agentId ?? null,
          data.amount,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/people/commissions/from-order', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      salesOrderId: z.string().uuid(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      createCommissionFromOrder(client, {
        organizationId,
        salesOrderId: data.salesOrderId,
      }),
    )

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/loans', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      customerId: z.string().uuid().optional(),
      expectedReturnDate: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(
        z.object({
          product_id: z.string().uuid().optional(),
          quantity: z.number().positive(),
        }),
      ),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      const loanResult = await client.query(
        `insert into loan_orders
          (organization_id, customer_id, status, expected_return_date, notes)
         values ($1, $2, 'open', $3::date, $4)
         returning id`,
        [
          organizationId,
          data.customerId ?? null,
          data.expectedReturnDate ?? null,
          data.notes ?? null,
        ],
      )

      const loanOrderId = loanResult.rows[0].id as string
      for (const item of data.items) {
        await client.query(
          `insert into loan_items
            (organization_id, loan_order_id, product_id, quantity)
           values ($1, $2, $3, $4)`,
          [organizationId, loanOrderId, item.product_id ?? null, item.quantity],
        )
      }

      return { loanOrderId }
    })

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.put('/people/employees/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      name: z.string().min(1),
      role: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update employees set name = $1, role = $2, email = $3, phone = $4
         where organization_id = $5 and id = $6 returning id`,
        [data.name, data.role ?? null, data.email ?? null, data.phone ?? null, organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Funcionário não encontrado.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/people/employees/:id/deactivate', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update employees set status = case when status = 'active' then 'inactive'::employee_status else 'active'::employee_status end
         where organization_id = $1 and id = $2 returning id, status`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Funcionário não encontrado.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/people/agents/:id/deactivate', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update sales_agents set active = not active
         where organization_id = $1 and id = $2 returning id, active`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Vendedor não encontrado.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/people/commissions/:id/pay', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update sales_commissions set status = 'paid'
         where organization_id = $1 and id = $2 and status = 'pending' returning id`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Comissão não encontrada ou já paga.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/people/commissions/:id/cancel', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update sales_commissions set status = 'canceled'
         where organization_id = $1 and id = $2 and status = 'pending' returning id`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Comissão não encontrada ou já processada.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/loans/:id/return', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update loan_orders set status = 'returned', returned_at = now()
         where organization_id = $1 and id = $2 and status = 'open' returning id`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Empréstimo não encontrado ou já devolvido.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/loans/:id/status', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ status: z.enum(['overdue', 'cancelled']) })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update loan_orders set status = $1
         where organization_id = $2 and id = $3 returning id`,
        [data.status, organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Empréstimo não encontrado.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

export { router as peopleRoutes }
