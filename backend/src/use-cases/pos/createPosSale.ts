import type { PoolClient } from 'pg'

type PosItemInput = {
  product_id?: string | null
  quantity: number
  unit_price: number
}

type PosPaymentInput = {
  method: string
  amount: number
}

type CreatePosSaleInput = {
  organizationId: string
  posSessionId?: string | null
  customerId?: string | null
  items: PosItemInput[]
  payments: PosPaymentInput[]
}

export async function createPosSale(client: PoolClient, input: CreatePosSaleInput) {
  const totalAmount = input.items.reduce(
    (sum, item) => sum + item.quantity * item.unit_price,
    0,
  )

  const saleResult = await client.query(
    `insert into pos_sales
      (organization_id, pos_session_id, customer_id, total_amount)
     values ($1, $2, $3, $4)
     returning id`,
    [
      input.organizationId,
      input.posSessionId ?? null,
      input.customerId ?? null,
      totalAmount,
    ],
  )

  const posSaleId = saleResult.rows[0].id as string

  for (const item of input.items) {
    await client.query(
      `insert into pos_sale_items
        (organization_id, pos_sale_id, product_id, quantity, unit_price, total_price)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.organizationId,
        posSaleId,
        item.product_id ?? null,
        item.quantity,
        item.unit_price,
        Number((item.quantity * item.unit_price).toFixed(2)),
      ],
    )
  }

  for (const payment of input.payments) {
    await client.query(
      `insert into pos_payments
        (organization_id, pos_sale_id, method, amount, status)
       values ($1, $2, $3, $4, 'paid')`,
      [input.organizationId, posSaleId, payment.method, payment.amount],
    )
  }

  return { posSaleId, totalAmount }
}
