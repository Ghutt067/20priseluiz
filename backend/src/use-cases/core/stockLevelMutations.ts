import type { PoolClient } from 'pg'

export const STOCK_QTY_EPSILON = 0.0001
const STOCK_LEVEL_NULL_BATCH_LOCK_SCOPE = 'stock_levels:null_batch'

export type FreeStockRow = {
  id: string
  freeQty: number
}

export function roundStockQty(value: number) {
  if (!Number.isFinite(value)) return 0
  return Number(value.toFixed(4))
}

async function lockNullBatchStockLevel(params: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  productId: string
}) {
  const { client, organizationId, warehouseId, productId } = params
  await client.query(`select pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    STOCK_LEVEL_NULL_BATCH_LOCK_SCOPE,
    `${organizationId}:${warehouseId}:${productId}`,
  ])
}

export async function increaseNullBatchStockLevel(params: {
  client: PoolClient
  organizationId: string
  productId: string
  warehouseId: string
  quantity: number
}) {
  const { client, organizationId, productId, warehouseId, quantity } = params
  const normalizedQty = roundStockQty(quantity)
  if (normalizedQty <= STOCK_QTY_EPSILON) return

  await lockNullBatchStockLevel({
    client,
    organizationId,
    warehouseId,
    productId,
  })

  const existingResult = await client.query(
    `select id
     from stock_levels
     where organization_id = $1
       and product_id = $2
       and warehouse_id = $3
       and batch_id is null
     order by qty_available desc, updated_at desc, id asc
     limit 1
     for update`,
    [organizationId, productId, warehouseId],
  )

  if ((existingResult.rowCount ?? 0) > 0) {
    await client.query(
      `update stock_levels
       set qty_available = qty_available + $1,
           updated_at = now()
       where id = $2`,
      [normalizedQty, existingResult.rows[0].id],
    )
    return
  }

  await client.query(
    `insert into stock_levels
      (organization_id, product_id, warehouse_id, qty_available, qty_reserved)
     values ($1, $2, $3, $4, 0)`,
    [organizationId, productId, warehouseId, normalizedQty],
  )
}

export async function loadFreeStockRowsForUpdate(params: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  productId: string
}) {
  const { client, organizationId, warehouseId, productId } = params
  const rowsResult = await client.query(
    `select id,
            qty_available::numeric as qty_available,
            qty_reserved::numeric as qty_reserved
     from stock_levels
     where organization_id = $1
       and warehouse_id = $2
       and product_id = $3
     order by qty_available desc, updated_at desc, id asc
     for update`,
    [organizationId, warehouseId, productId],
  )

  return rowsResult.rows.map((row) => {
    const qtyAvailable = roundStockQty(Number(row.qty_available ?? 0))
    const qtyReserved = roundStockQty(Number(row.qty_reserved ?? 0))
    return {
      id: row.id as string,
      freeQty: roundStockQty(Math.max(qtyAvailable - qtyReserved, 0)),
    }
  }) satisfies FreeStockRow[]
}

export function sumFreeStock(rows: FreeStockRow[]) {
  return roundStockQty(rows.reduce((sum, row) => sum + row.freeQty, 0))
}

export async function deductFromFreeStockRows(params: {
  client: PoolClient
  rows: FreeStockRow[]
  quantity: number
}) {
  const { client, rows, quantity } = params
  let remainingToReduce = roundStockQty(quantity)

  for (const row of rows) {
    if (remainingToReduce <= STOCK_QTY_EPSILON) {
      break
    }
    if (row.freeQty <= STOCK_QTY_EPSILON) {
      continue
    }

    const deduction = roundStockQty(Math.min(row.freeQty, remainingToReduce))
    if (deduction <= STOCK_QTY_EPSILON) {
      continue
    }

    await client.query(
      `update stock_levels
       set qty_available = qty_available - $1,
           updated_at = now()
       where id = $2`,
      [deduction, row.id],
    )

    row.freeQty = roundStockQty(row.freeQty - deduction)
    remainingToReduce = roundStockQty(remainingToReduce - deduction)
  }

  return remainingToReduce
}
