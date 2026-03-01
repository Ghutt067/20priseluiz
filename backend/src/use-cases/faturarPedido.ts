import type { PoolClient } from 'pg'

type FaturarPedidoInput = {
  salesOrderId: string
}

function toNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function consumeStockForProduct(params: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  productId: string
  quantity: number
  description: string
}) {
  const { client, organizationId, warehouseId, productId, quantity, description } = params
  const stockRowsResult = await client.query(
    `select id, qty_available, qty_reserved
     from stock_levels
     where organization_id = $1
       and warehouse_id = $2
       and product_id = $3
     order by id asc
     for update`,
    [organizationId, warehouseId, productId],
  )

  const stockRows = stockRowsResult.rows.map((row) => ({
    id: row.id as string,
    qtyAvailable: toNumber(row.qty_available),
    qtyReserved: toNumber(row.qty_reserved),
  }))

  const totalAvailable = stockRows.reduce((sum, row) => sum + row.qtyAvailable, 0)
  if (totalAvailable + 0.0001 < quantity) {
    throw new Error(
      `Estoque indisponível para faturar "${description}". Disponível: ${totalAvailable.toFixed(4)} | Necessário: ${quantity.toFixed(4)}.`,
    )
  }

  let remaining = quantity

  for (const row of stockRows) {
    if (remaining <= 0) break
    if (row.qtyReserved <= 0) continue
    const consumeReserved = Math.min(row.qtyReserved, remaining)
    await client.query(
      `update stock_levels
       set qty_reserved = qty_reserved - $1,
           qty_available = qty_available - $1,
           updated_at = now()
       where id = $2`,
      [consumeReserved, row.id],
    )
    row.qtyReserved -= consumeReserved
    row.qtyAvailable -= consumeReserved
    remaining -= consumeReserved
  }

  for (const row of stockRows) {
    if (remaining <= 0) break
    const freeQty = Math.max(row.qtyAvailable - row.qtyReserved, 0)
    if (freeQty <= 0) continue

    const consumeFree = Math.min(freeQty, remaining)
    await client.query(
      `update stock_levels
       set qty_available = qty_available - $1,
           updated_at = now()
       where id = $2`,
      [consumeFree, row.id],
    )

    row.qtyAvailable -= consumeFree
    remaining -= consumeFree
  }

  if (remaining > 0.0001) {
    throw new Error(`Não foi possível consumir estoque para "${description}" no faturamento.`)
  }
}

export async function faturarPedido(
  client: PoolClient,
  input: FaturarPedidoInput,
) {
  const orderResult = await client.query(
    'select * from sales_orders where id = $1',
    [input.salesOrderId],
  )

  if (orderResult.rowCount === 0) {
    throw new Error('Pedido nao encontrado.')
  }

  const order = orderResult.rows[0]

  const itemsResult = await client.query(
    `select soi.*, p.product_type
     from sales_order_items soi
     left join products p on p.id = soi.product_id
     where soi.sales_order_id = $1`,
    [input.salesOrderId],
  )

  const items = itemsResult.rows
  const totalAmount = items.reduce(
    (sum, item) => sum + Number(item.total_price || 0),
    0,
  )

  const invoiceResult = await client.query(
    `insert into invoices (organization_id, sales_order_id, customer_id, origin, total_amount, status, issued_at)
     values ($1, $2, $3, 'sales_order', $4, 'open', now())
     returning id`,
    [order.organization_id, order.id, order.customer_id, totalAmount],
  )

  const invoiceId = invoiceResult.rows[0].id

  const fiscalResult = await client.query(
    `insert into fiscal_documents (organization_id, invoice_id, doc_type, status, issue_date)
     values ($1, $2, 'nfe', 'draft', now())
     returning id`,
    [order.organization_id, invoiceId],
  )

  const fiscalDocumentId = fiscalResult.rows[0].id

  for (const item of items) {
    await client.query(
      `insert into fiscal_document_items
        (organization_id, document_id, product_id, description, quantity, unit_price, total_price, ncm, cfop)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        order.organization_id,
        fiscalDocumentId,
        item.product_id,
        item.description,
        item.quantity,
        item.unit_price,
        item.total_price,
        item.ncm || null,
        item.cfop || null,
      ],
    )

    if (item.product_type === 'product') {
      if (!order.warehouse_id) {
        throw new Error('Pedido sem warehouse_id não pode ser faturado com itens de estoque.')
      }
      if (!item.product_id) {
        throw new Error('Item de produto sem referência de product_id no faturamento.')
      }

      await consumeStockForProduct({
        client,
        organizationId: order.organization_id as string,
        warehouseId: order.warehouse_id as string,
        productId: item.product_id as string,
        quantity: toNumber(item.quantity),
        description: (item.description as string) ?? 'Item sem descrição',
      })

      await client.query(
        `insert into stock_movements
          (organization_id, product_id, warehouse_id, movement_type, quantity, reason, ref_table, ref_id)
         values ($1, $2, $3, 'out', $4, 'Faturamento', 'sales_orders', $5)`,
        [
          order.organization_id,
          item.product_id,
          order.warehouse_id,
          item.quantity,
          order.id,
        ],
      )
    }
  }

  const titleResult = await client.query(
    `insert into financial_titles
      (organization_id, title_type, customer_id, invoice_id, description, total_amount, status)
     values ($1, 'receivable', $2, $3, $4, $5, 'open')
     returning id`,
    [
      order.organization_id,
      order.customer_id,
      invoiceId,
      `Faturamento do pedido ${order.id}`,
      totalAmount,
    ],
  )

  await client.query(
    `insert into financial_installments
      (organization_id, title_id, due_date, amount, status)
     values ($1, $2, current_date + interval '30 day', $3, 'open')`,
    [order.organization_id, titleResult.rows[0].id, totalAmount],
  )

  await client.query(
    `update sales_orders
     set status = 'invoiced', updated_at = now()
     where id = $1`,
    [order.id],
  )

  return { invoiceId, fiscalDocumentId }
}
