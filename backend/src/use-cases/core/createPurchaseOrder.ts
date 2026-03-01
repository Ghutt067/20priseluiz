import type { PoolClient } from 'pg'

type PurchaseOrderItemInput = {
  product_id?: string | null
  description: string
  quantity: number
  unit_cost: number
}

type CreatePurchaseOrderInput = {
  organizationId: string
  supplierId: string
  warehouseId: string
  items: PurchaseOrderItemInput[]
  notes?: string | null
}

export async function createPurchaseOrder(
  client: PoolClient,
  input: CreatePurchaseOrderInput,
) {
  const items = input.items.map((item) => ({
    ...item,
    total_cost: Number((item.quantity * item.unit_cost).toFixed(2)),
  }))

  const totalAmount = items.reduce((sum, item) => sum + item.total_cost, 0)

  const orderResult = await client.query(
    `insert into purchase_orders
      (organization_id, supplier_id, warehouse_id, status, total_amount, notes)
     values ($1, $2, $3, 'approved', $4, $5)
     returning id`,
    [
      input.organizationId,
      input.supplierId,
      input.warehouseId,
      totalAmount,
      input.notes ?? null,
    ],
  )

  const orderId = orderResult.rows[0].id as string

  for (const item of items) {
    await client.query(
      `insert into purchase_order_items
        (organization_id, purchase_order_id, product_id, description, quantity, unit_cost, total_cost)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.organizationId,
        orderId,
        item.product_id ?? null,
        item.description,
        item.quantity,
        item.unit_cost,
        item.total_cost,
      ],
    )
  }

  return { orderId, totalAmount }
}
