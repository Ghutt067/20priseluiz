import type { PoolClient } from 'pg'

type SalesOrderItemInput = {
  product_id?: string | null
  description: string
  quantity: number
  unit_price: number
  ncm?: string | null
  cfop?: string | null
}

type CreateSalesOrderInput = {
  organizationId: string
  customerId?: string | null
  quoteId?: string | null
  warehouseId?: string | null
  salesAgentId?: string | null
  items: SalesOrderItemInput[]
  notes?: string | null
  paymentCondition?: string | null
  discountPercent?: number | null
}

type ProductLookupRow = {
  id: string
  name: string
  product_type: 'product' | 'service'
}

function toNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function reserveStockForProduct(params: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  productId: string
  requiredQty: number
  description: string
}) {
  const { client, organizationId, warehouseId, productId, requiredQty, description } = params
  const stockRows = await client.query(
    `select id, qty_available, qty_reserved
     from stock_levels
     where organization_id = $1
       and warehouse_id = $2
       and product_id = $3
     order by id asc
     for update`,
    [organizationId, warehouseId, productId],
  )

  const availableQty = stockRows.rows.reduce((sum, row) => {
    const qtyAvailable = toNumber(row.qty_available)
    const qtyReserved = toNumber(row.qty_reserved)
    return sum + Math.max(qtyAvailable - qtyReserved, 0)
  }, 0)

  if (availableQty + 0.0001 < requiredQty) {
    throw new Error(
      `Estoque insuficiente para "${description}". Disponível: ${availableQty.toFixed(4)} | Necessário: ${requiredQty.toFixed(4)}.`,
    )
  }

  let pendingQty = requiredQty
  for (const row of stockRows.rows) {
    if (pendingQty <= 0) break
    const qtyAvailable = toNumber(row.qty_available)
    const qtyReserved = toNumber(row.qty_reserved)
    const freeQty = Math.max(qtyAvailable - qtyReserved, 0)
    if (freeQty <= 0) continue

    const reserveQty = Math.min(freeQty, pendingQty)
    await client.query(
      `update stock_levels
       set qty_reserved = qty_reserved + $1,
           updated_at = now()
       where id = $2`,
      [reserveQty, row.id],
    )

    pendingQty -= reserveQty
  }

  if (pendingQty > 0.0001) {
    throw new Error(
      `Não foi possível reservar estoque suficiente para "${description}".`,
    )
  }
}

export async function createSalesOrder(client: PoolClient, input: CreateSalesOrderInput) {
  if (input.items.length === 0) {
    throw new Error('Pedido deve ter pelo menos um item.')
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

  if (input.warehouseId) {
    const warehouseResult = await client.query(
      `select 1
       from warehouses
       where organization_id = $1
         and id = $2
       limit 1`,
      [input.organizationId, input.warehouseId],
    )
    if ((warehouseResult.rowCount ?? 0) === 0) {
      throw new Error('Depósito informado não pertence à organização.')
    }
  }

  if (input.salesAgentId) {
    const salesAgentResult = await client.query(
      `select 1
       from sales_agents
       where organization_id = $1
         and id = $2
       limit 1`,
      [input.organizationId, input.salesAgentId],
    )
    if ((salesAgentResult.rowCount ?? 0) === 0) {
      throw new Error('Vendedor informado não pertence à organização.')
    }
  }

  const items = input.items.map((item) => ({
    ...item,
    total_price: Number((item.quantity * item.unit_price).toFixed(2)),
  }))

  const productIds = Array.from(
    new Set(items.map((item) => item.product_id).filter((id): id is string => Boolean(id))),
  )

  const productsById = new Map<string, ProductLookupRow>()
  if (productIds.length > 0) {
    const productsResult = await client.query(
      `select id, name, product_type
       from products
       where organization_id = $1
         and id = any($2::uuid[])`,
      [input.organizationId, productIds],
    )

    for (const row of productsResult.rows as ProductLookupRow[]) {
      productsById.set(row.id, row)
    }

    for (const productId of productIds) {
      if (!productsById.has(productId)) {
        throw new Error('Produto informado no pedido não foi encontrado na organização.')
      }
    }
  }

  const requiredByProduct = new Map<string, { quantity: number; description: string }>()
  for (const item of items) {
    if (!item.product_id) continue
    const product = productsById.get(item.product_id)
    if (product?.product_type !== 'product') continue

    const previous = requiredByProduct.get(item.product_id)
    requiredByProduct.set(item.product_id, {
      quantity: (previous?.quantity ?? 0) + Number(item.quantity ?? 0),
      description: item.description || product.name,
    })
  }

  if (requiredByProduct.size > 0 && !input.warehouseId) {
    throw new Error('warehouseId é obrigatório para pedidos com itens de estoque.')
  }

  if (input.warehouseId) {
    for (const [productId, required] of requiredByProduct.entries()) {
      await reserveStockForProduct({
        client,
        organizationId: input.organizationId,
        warehouseId: input.warehouseId,
        productId,
        requiredQty: required.quantity,
        description: required.description,
      })
    }
  }

  const totalAmount = items.reduce((sum, item) => sum + item.total_price, 0)

  const orderResult = await client.query(
    `insert into sales_orders
      (organization_id, customer_id, quote_id, warehouse_id, sales_agent_id, status, total_amount, notes)
     values ($1, $2, $3, $4, $5, 'open', $6, $7)
     returning id`,
    [
      input.organizationId,
      input.customerId ?? null,
      input.quoteId ?? null,
      input.warehouseId ?? null,
      input.salesAgentId ?? null,
      totalAmount,
      input.notes ?? null,
    ],
  )

  const orderId = orderResult.rows[0].id as string

  for (const item of items) {
    await client.query(
      `insert into sales_order_items
        (organization_id, sales_order_id, product_id, description, quantity, unit_price, total_price, ncm, cfop)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.organizationId,
        orderId,
        item.product_id ?? null,
        item.description,
        item.quantity,
        item.unit_price,
        item.total_price,
        item.ncm ?? null,
        item.cfop ?? null,
      ],
    )
  }

  return { orderId, totalAmount }
}
