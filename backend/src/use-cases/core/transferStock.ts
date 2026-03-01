import type { PoolClient } from 'pg'
import {
  STOCK_QTY_EPSILON,
  deductFromFreeStockRows,
  increaseNullBatchStockLevel,
  loadFreeStockRowsForUpdate,
  sumFreeStock,
  type FreeStockRow,
} from './stockLevelMutations'

type TransferItemInput = {
  product_id: string
  quantity: number
}

type TransferStockInput = {
  organizationId: string
  originWarehouseId: string
  destinationWarehouseId: string
  items: TransferItemInput[]
  notes?: string | null
}

async function loadOriginStockRowsByProduct(params: {
  client: PoolClient
  organizationId: string
  originWarehouseId: string
  requiredByProduct: Map<string, number>
}) {
  const { client, organizationId, originWarehouseId, requiredByProduct } = params
  const rowsByProduct = new Map<string, FreeStockRow[]>()

  for (const [productId, requiredQty] of requiredByProduct.entries()) {
    if (!Number.isFinite(requiredQty) || requiredQty <= 0) {
      throw new Error('Quantidade da transferência deve ser maior que zero.')
    }

    const stockRows = await loadFreeStockRowsForUpdate({
      client,
      organizationId,
      warehouseId: originWarehouseId,
      productId,
    })
    const freeQty = sumFreeStock(stockRows)
    if (freeQty + STOCK_QTY_EPSILON < requiredQty) {
      throw new Error(
        `Estoque livre insuficiente para transferência. Produto ${productId.slice(0, 8)}: disponível ${freeQty.toFixed(4)} | solicitado ${requiredQty.toFixed(4)}.`,
      )
    }

    rowsByProduct.set(productId, stockRows)
  }

  return rowsByProduct
}

export async function transferStock(client: PoolClient, input: TransferStockInput) {
  if (input.originWarehouseId === input.destinationWarehouseId) {
    throw new Error('Origem e destino nao podem ser iguais.')
  }

  if (input.items.length === 0) {
    throw new Error('Transferência precisa ter ao menos um item.')
  }

  const requiredByProduct = new Map<string, number>()
  for (const item of input.items) {
    const current = requiredByProduct.get(item.product_id) ?? 0
    requiredByProduct.set(item.product_id, current + Number(item.quantity ?? 0))
  }

  const originStockRowsByProduct = await loadOriginStockRowsByProduct({
    client,
    organizationId: input.organizationId,
    originWarehouseId: input.originWarehouseId,
    requiredByProduct,
  })

  const transferResult = await client.query(
    `insert into stock_transfers
      (organization_id, origin_warehouse_id, destination_warehouse_id, status, notes)
     values ($1, $2, $3, 'completed', $4)
     returning id`,
    [
      input.organizationId,
      input.originWarehouseId,
      input.destinationWarehouseId,
      input.notes ?? null,
    ],
  )

  const transferId = transferResult.rows[0].id as string

  for (const item of input.items) {
    await client.query(
      `insert into stock_transfer_items
        (organization_id, transfer_id, product_id, quantity)
       values ($1, $2, $3, $4)`,
      [input.organizationId, transferId, item.product_id, item.quantity],
    )

    await client.query(
      `insert into stock_movements
        (organization_id, product_id, warehouse_id, movement_type, quantity, reason, ref_table, ref_id)
       values ($1, $2, $3, 'out', $4, 'Transferencia', 'stock_transfers', $5)`,
      [input.organizationId, item.product_id, input.originWarehouseId, item.quantity, transferId],
    )

    await client.query(
      `insert into stock_movements
        (organization_id, product_id, warehouse_id, movement_type, quantity, reason, ref_table, ref_id)
       values ($1, $2, $3, 'in', $4, 'Transferencia', 'stock_transfers', $5)`,
      [
        input.organizationId,
        item.product_id,
        input.destinationWarehouseId,
        item.quantity,
        transferId,
      ],
    )

    await increaseNullBatchStockLevel({
      client,
      organizationId: input.organizationId,
      productId: item.product_id,
      warehouseId: input.destinationWarehouseId,
      quantity: item.quantity,
    })

    const originRows = originStockRowsByProduct.get(item.product_id)
    if (!originRows || originRows.length === 0) {
      throw new Error(
        `Falha ao deduzir estoque da origem para o produto ${item.product_id.slice(0, 8)}.`,
      )
    }

    const remainingToReduce = await deductFromFreeStockRows({
      client,
      rows: originRows,
      quantity: item.quantity,
    })

    if (remainingToReduce > STOCK_QTY_EPSILON) {
      throw new Error(
        `Falha ao deduzir estoque de origem. Produto ${item.product_id.slice(0, 8)} com saldo livre insuficiente durante a transferência.`,
      )
    }
  }

  return { transferId }
}
