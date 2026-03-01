import type { PoolClient } from 'pg'

type ServiceItemInput = {
  product_id?: string | null
  description: string
  quantity: number
  unit_price: number
  hours_worked?: number
}

type ChecklistInput = {
  item: string
}

type CreateServiceOrderInput = {
  organizationId: string
  customerId?: string | null
  vehicleId?: string | null
  scheduledAt?: string | null
  notes?: string | null
  items: ServiceItemInput[]
  checklist?: ChecklistInput[]
}

export async function createServiceOrder(
  client: PoolClient,
  input: CreateServiceOrderInput,
) {
  const items = input.items.map((item) => ({
    ...item,
    total_price: Number((item.quantity * item.unit_price).toFixed(2)),
  }))

  const totalAmount = items.reduce((sum, item) => sum + item.total_price, 0)

  const orderResult = await client.query(
    `insert into service_orders
      (organization_id, customer_id, vehicle_id, status, total_amount, notes, scheduled_at)
     values ($1, $2, $3, 'open', $4, $5, $6)
     returning id`,
    [
      input.organizationId,
      input.customerId ?? null,
      input.vehicleId ?? null,
      totalAmount,
      input.notes ?? null,
      input.scheduledAt ?? null,
    ],
  )

  const orderId = orderResult.rows[0].id as string

  for (const item of items) {
    await client.query(
      `insert into service_order_items
        (organization_id, service_order_id, product_id, description, quantity, unit_price, total_price, hours_worked)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.organizationId,
        orderId,
        item.product_id ?? null,
        item.description,
        item.quantity,
        item.unit_price,
        item.total_price,
        item.hours_worked ?? 0,
      ],
    )
  }

  if (input.checklist?.length) {
    for (const checklistItem of input.checklist) {
      await client.query(
        `insert into service_checklists
          (organization_id, service_order_id, item, is_done)
         values ($1, $2, $3, false)`,
        [input.organizationId, orderId, checklistItem.item],
      )
    }
  }

  return { serviceOrderId: orderId, totalAmount }
}
