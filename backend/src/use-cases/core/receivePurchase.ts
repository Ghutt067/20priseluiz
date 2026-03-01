import type { PoolClient } from 'pg'
import { increaseNullBatchStockLevel } from './stockLevelMutations'

type PurchaseReceiptItemInput = {
  purchase_order_item_id?: string | null
  product_id?: string | null
  description: string
  quantity: number
  unit_cost: number
}

type ReceivePurchaseInput = {
  organizationId: string
  purchaseOrderId?: string | null
  supplierId?: string | null
  warehouseId: string
  items: PurchaseReceiptItemInput[]
  notes?: string | null
}

export async function receivePurchase(client: PoolClient, input: ReceivePurchaseInput) {
  const items = input.items.map((item) => ({
    ...item,
    total_cost: Number((item.quantity * item.unit_cost).toFixed(2)),
  }))

  const totalAmount = items.reduce((sum, item) => sum + item.total_cost, 0)

  const receiptResult = await client.query(
    `insert into purchase_receipts
      (organization_id, purchase_order_id, supplier_id, warehouse_id, status, total_amount, notes, received_at)
     values ($1, $2, $3, $4, 'received', $5, $6, now())
     returning id`,
    [
      input.organizationId,
      input.purchaseOrderId ?? null,
      input.supplierId ?? null,
      input.warehouseId,
      totalAmount,
      input.notes ?? null,
    ],
  )

  const receiptId = receiptResult.rows[0].id as string

  for (const item of items) {
    await client.query(
      `insert into purchase_receipt_items
        (organization_id, purchase_receipt_id, purchase_order_item_id, product_id, description, quantity, unit_cost, total_cost)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.organizationId,
        receiptId,
        item.purchase_order_item_id ?? null,
        item.product_id ?? null,
        item.description,
        item.quantity,
        item.unit_cost,
        item.total_cost,
      ],
    )

    if (item.product_id) {
      await client.query(
        `insert into stock_movements
          (organization_id, product_id, warehouse_id, movement_type, quantity, unit_cost, reason, ref_table, ref_id)
         values ($1, $2, $3, 'in', $4, $5, 'Entrada de compra', 'purchase_receipts', $6)`,
        [
          input.organizationId,
          item.product_id,
          input.warehouseId,
          item.quantity,
          item.unit_cost,
          receiptId,
        ],
      )

      await increaseNullBatchStockLevel({
        client,
        organizationId: input.organizationId,
        productId: item.product_id,
        warehouseId: input.warehouseId,
        quantity: item.quantity,
      })
    }
  }

  if (input.purchaseOrderId) {
    const pendingLinesResult = await client.query(
      `select count(*)::int as pending_lines
       from purchase_order_items poi
       left join (
         select pri.purchase_order_item_id,
                sum(pri.quantity)::numeric as received_quantity
         from purchase_receipt_items pri
         inner join purchase_receipts pr
                 on pr.id = pri.purchase_receipt_id
                and pr.organization_id = pri.organization_id
         where pri.organization_id = $1
           and pr.purchase_order_id = $2
           and pr.status <> 'cancelled'
           and pri.purchase_order_item_id is not null
         group by pri.purchase_order_item_id
       ) received on received.purchase_order_item_id = poi.id
       where poi.organization_id = $1
         and poi.purchase_order_id = $2
         and poi.quantity - coalesce(received.received_quantity, 0) > 0.000001`,
      [input.organizationId, input.purchaseOrderId],
    )
    const pendingLines = Number(pendingLinesResult.rows[0]?.pending_lines ?? 0)
    const nextOrderStatus = pendingLines === 0 ? 'received' : 'approved'

    await client.query(
      `update purchase_orders
       set status = $3,
           updated_at = now()
       where id = $1
         and organization_id = $2`,
      [input.purchaseOrderId, input.organizationId, nextOrderStatus],
    )
  }

  return { receiptId, totalAmount }
}
