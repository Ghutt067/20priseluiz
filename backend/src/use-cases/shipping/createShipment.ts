import type { PoolClient } from 'pg'

type ShipmentItemInput = {
  product_id?: string | null
  quantity: number
}

type CreateShipmentInput = {
  organizationId: string
  salesOrderId?: string | null
  customerId?: string | null
  type?: 'delivery' | 'pickup'
  carrier?: string | null
  trackingCode?: string | null
  items: ShipmentItemInput[]
}

export async function createShipment(client: PoolClient, input: CreateShipmentInput) {
  if (input.items.length === 0) {
    throw new Error('Expedição precisa ter ao menos um item.')
  }

  if (input.salesOrderId) {
    const orderResult = await client.query(
      `select 1
       from sales_orders
       where organization_id = $1
         and id = $2
       limit 1`,
      [input.organizationId, input.salesOrderId],
    )
    if ((orderResult.rowCount ?? 0) === 0) {
      throw new Error('Pedido informado não pertence à organização.')
    }
  }

  if (input.customerId) {
    const customerResult = await client.query(
      `select 1
       from customers
       where organization_id = $1
         and id = $2
       limit 1`,
      [input.organizationId, input.customerId],
    )
    if ((customerResult.rowCount ?? 0) === 0) {
      throw new Error('Cliente informado não pertence à organização.')
    }
  }

  const productIds = Array.from(
    new Set(input.items.map((item) => item.product_id).filter((id): id is string => Boolean(id))),
  )
  if (productIds.length > 0) {
    const productsResult = await client.query(
      `select id
       from products
       where organization_id = $1
         and id = any($2::uuid[])`,
      [input.organizationId, productIds],
    )
    if (productsResult.rows.length !== productIds.length) {
      throw new Error('Há itens de expedição com produto inválido para esta organização.')
    }
  }

  const result = await client.query(
    `insert into shipments
      (organization_id, sales_order_id, customer_id, type, status, carrier, tracking_code)
     values ($1, $2, $3, $4, 'pending', $5, $6)
     returning id`,
    [
      input.organizationId,
      input.salesOrderId ?? null,
      input.customerId ?? null,
      input.type ?? 'delivery',
      input.carrier ?? null,
      input.trackingCode ?? null,
    ],
  )

  const shipmentId = result.rows[0].id as string

  for (const item of input.items) {
    await client.query(
      `insert into shipment_items
        (organization_id, shipment_id, product_id, quantity)
       values ($1, $2, $3, $4)`,
      [input.organizationId, shipmentId, item.product_id ?? null, item.quantity],
    )
  }

  return { shipmentId }
}
