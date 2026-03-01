import type { PoolClient } from 'pg'

type CreateCommissionInput = {
  organizationId: string
  salesOrderId: string
}

export async function createCommissionFromOrder(
  client: PoolClient,
  input: CreateCommissionInput,
) {
  const orderResult = await client.query(
    `select id, sales_agent_id, total_amount
     from sales_orders
     where id = $1`,
    [input.salesOrderId],
  )

  if (orderResult.rowCount === 0) {
    throw new Error('Pedido nao encontrado.')
  }

  const order = orderResult.rows[0]
  if (!order.sales_agent_id) {
    throw new Error('Pedido sem vendedor associado.')
  }

  const agentResult = await client.query(
    `select id, commission_rate
     from sales_agents
     where id = $1`,
    [order.sales_agent_id],
  )

  if (agentResult.rowCount === 0) {
    throw new Error('Vendedor nao encontrado.')
  }

  const rate = Number(agentResult.rows[0].commission_rate ?? 0)
  const amount = Number(((order.total_amount * rate) / 100).toFixed(2))

  const result = await client.query(
    `insert into sales_commissions
      (organization_id, sales_order_id, agent_id, amount, status)
     values ($1, $2, $3, $4, 'pending')
     returning id`,
    [input.organizationId, order.id, order.sales_agent_id, amount],
  )

  return { commissionId: result.rows[0].id as string, amount }
}
