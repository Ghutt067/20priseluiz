import { z } from 'zod'

const purchaseItemSchema = z.object({
  purchase_order_item_id: z.uuid().optional(),
  product_id: z.uuid().optional(),
  description: z.string().trim().min(1),
  quantity: z.number().positive(),
  unit_cost: z.number().nonnegative(),
})

export const purchaseOrderRequestSchema = z.object({
  supplierId: z.uuid(),
  warehouseId: z.uuid(),
  notes: z.string().optional(),
  items: z.array(purchaseItemSchema).min(1, 'Compra deve ter pelo menos um item.'),
})

export const purchaseReceiveRequestSchema = z
  .object({
    purchaseOrderId: z.uuid().optional(),
    supplierId: z.uuid().optional(),
    warehouseId: z.uuid(),
    notes: z.string().optional(),
    items: z.array(purchaseItemSchema).min(1, 'Recebimento deve ter pelo menos um item.'),
  })
  .refine((value) => Boolean(value.purchaseOrderId || value.supplierId), {
    message: 'Recebimento precisa de ordem de compra ou fornecedor.',
    path: ['supplierId'],
  })

export type PurchaseOrderRequest = z.infer<typeof purchaseOrderRequestSchema>
export type PurchaseReceiveRequest = z.infer<typeof purchaseReceiveRequestSchema>

export type PurchaseOrderSnapshot = {
  status: string | null
  supplierId: string | null
  warehouseId: string | null
}

export type PurchaseOrderReceiveLine = {
  purchaseOrderItemId: string
  productId: string | null
  description: string
  remainingQuantity: number
}

export type PurchaseReceiveItemInput = {
  purchase_order_item_id?: string
  product_id?: string
  description: string
  quantity: number
  unit_cost: number
}

function normalizeText(value: string) {
  return value.trim().toLowerCase()
}

function fallbackMatchesOrderLine(item: PurchaseReceiveItemInput, line: PurchaseOrderReceiveLine) {
  if (item.product_id) {
    return line.productId === item.product_id
  }
  if (line.productId) {
    return false
  }
  return normalizeText(item.description) === normalizeText(line.description)
}

function assertWithinRemaining(
  itemIndex: number,
  line: PurchaseOrderReceiveLine,
  receivedQuantityForLine: number,
) {
  if (receivedQuantityForLine > line.remainingQuantity + 0.000001) {
    throw new Error(
      `Item ${itemIndex + 1}: quantidade excede o saldo pendente da ordem de compra.`,
    )
  }
}

function resolveOrderLineIdForItem(
  item: PurchaseReceiveItemInput,
  orderLines: PurchaseOrderReceiveLine[],
  lineById: Map<string, PurchaseOrderReceiveLine>,
  itemIndex: number,
) {
  if (item.purchase_order_item_id) {
    const line = lineById.get(item.purchase_order_item_id)
    if (!line) {
      throw new Error(`Item ${itemIndex + 1}: linha da ordem de compra não encontrada.`)
    }
    return line.purchaseOrderItemId
  }

  const candidates = orderLines.filter(
    (line) => line.remainingQuantity > 0 && fallbackMatchesOrderLine(item, line),
  )
  if (candidates.length === 0) {
    throw new Error(
      `Item ${itemIndex + 1}: não corresponde a nenhuma linha pendente da ordem de compra.`,
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `Item ${itemIndex + 1}: corresponde a múltiplas linhas da ordem. Recarregue a ordem para selecionar a linha correta.`,
    )
  }
  return candidates[0].purchaseOrderItemId
}

export function mapReceiveItemsToOrderLines(params: {
  items: PurchaseReceiveItemInput[]
  orderLines: PurchaseOrderReceiveLine[]
}) {
  if (params.orderLines.length === 0) {
    throw new Error('Ordem de compra não possui itens para recebimento.')
  }

  const lineById = new Map(params.orderLines.map((line) => [line.purchaseOrderItemId, line] as const))
  const receivedByLineId = new Map<string, number>()

  const mappedItems = params.items.map((item, itemIndex) => {
    const purchaseOrderItemId = resolveOrderLineIdForItem(
      item,
      params.orderLines,
      lineById,
      itemIndex,
    )
    const line = lineById.get(purchaseOrderItemId)
    if (!line) {
      throw new Error(`Item ${itemIndex + 1}: linha da ordem de compra não encontrada.`)
    }

    const receivedQuantityForLine = (receivedByLineId.get(purchaseOrderItemId) ?? 0) + item.quantity
    assertWithinRemaining(itemIndex, line, receivedQuantityForLine)
    receivedByLineId.set(purchaseOrderItemId, receivedQuantityForLine)

    return {
      ...item,
      purchase_order_item_id: purchaseOrderItemId,
      product_id: item.product_id ?? line.productId ?? undefined,
    }
  })

  return {
    mappedItems,
    receivedByLineId,
  }
}

function assertOrderCanBeReceived(status: string | null) {
  if (status === 'received') {
    throw new Error('Esta ordem de compra já foi recebida.')
  }
  if (status === 'cancelled') {
    throw new Error('Ordem de compra cancelada não pode ser recebida.')
  }
  if (status === 'draft') {
    throw new Error('Ordem de compra precisa estar aprovada para receber mercadorias.')
  }
}

function assertReceiveWarehouseMatchesOrder(orderWarehouseId: string | null, receiveWarehouseId: string) {
  if (orderWarehouseId && orderWarehouseId !== receiveWarehouseId) {
    throw new Error('Depósito do recebimento difere do depósito da ordem de compra.')
  }
}

function assertReceiveSupplierMatchesOrder(orderSupplierId: string | null, receiveSupplierId?: string) {
  if (orderSupplierId && receiveSupplierId && orderSupplierId !== receiveSupplierId) {
    throw new Error('Fornecedor do recebimento difere do fornecedor da ordem de compra.')
  }
}

function resolveSupplierId(receiveSupplierId: string | undefined, orderSupplierId: string | null) {
  const resolvedSupplierId = receiveSupplierId ?? orderSupplierId
  if (!resolvedSupplierId) {
    throw new Error('Fornecedor é obrigatório para registrar recebimento.')
  }
  return resolvedSupplierId
}

export function resolveReceiveSupplierAndValidate(
  input: {
    supplierId?: string
    warehouseId: string
  },
  orderSnapshot: PurchaseOrderSnapshot | null,
) {
  const previousOrderStatus = orderSnapshot?.status ?? null

  if (orderSnapshot) {
    assertOrderCanBeReceived(orderSnapshot.status)
    assertReceiveWarehouseMatchesOrder(orderSnapshot.warehouseId, input.warehouseId)
    assertReceiveSupplierMatchesOrder(orderSnapshot.supplierId, input.supplierId)
  }

  const resolvedSupplierId = resolveSupplierId(input.supplierId, orderSnapshot?.supplierId ?? null)

  return {
    resolvedSupplierId,
    previousOrderStatus,
  }
}
