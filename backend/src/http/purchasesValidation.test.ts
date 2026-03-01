import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mapReceiveItemsToOrderLines,
  purchaseOrderRequestSchema,
  purchaseReceiveRequestSchema,
  resolveReceiveSupplierAndValidate,
} from './purchasesValidation'

test('purchase order schema accepts required commercial payload', () => {
  const parsed = purchaseOrderRequestSchema.parse({
    supplierId: '11111111-1111-4111-8111-111111111111',
    warehouseId: '22222222-2222-4222-8222-222222222222',
    items: [
      {
        product_id: '33333333-3333-4333-8333-333333333333',
        description: 'Caixa de embalagem',
        quantity: 10,
        unit_cost: 4.5,
      },
    ],
  })

  assert.equal(parsed.supplierId, '11111111-1111-4111-8111-111111111111')
  assert.equal(parsed.warehouseId, '22222222-2222-4222-8222-222222222222')
  assert.equal(parsed.items.length, 1)
})

test('purchase order schema rejects payload without supplier', () => {
  const result = purchaseOrderRequestSchema.safeParse({
    warehouseId: '22222222-2222-4222-8222-222222222222',
    items: [
      {
        description: 'Fita adesiva',
        quantity: 2,
        unit_cost: 6,
      },
    ],
  })

  assert.equal(result.success, false)
})

test('purchase receive schema rejects payload without order and supplier', () => {
  const result = purchaseReceiveRequestSchema.safeParse({
    warehouseId: '22222222-2222-4222-8222-222222222222',
    items: [
      {
        description: 'Fita adesiva',
        quantity: 2,
        unit_cost: 6,
      },
    ],
  })

  assert.equal(result.success, false)
})

test('resolveReceiveSupplierAndValidate derives supplier from order', () => {
  const resolved = resolveReceiveSupplierAndValidate(
    {
      warehouseId: '22222222-2222-4222-8222-222222222222',
    },
    {
      status: 'approved',
      supplierId: '11111111-1111-4111-8111-111111111111',
      warehouseId: '22222222-2222-4222-8222-222222222222',
    },
  )

  assert.equal(resolved.resolvedSupplierId, '11111111-1111-4111-8111-111111111111')
  assert.equal(resolved.previousOrderStatus, 'approved')
})

test('resolveReceiveSupplierAndValidate blocks duplicate receive for order already received', () => {
  assert.throws(
    () =>
      resolveReceiveSupplierAndValidate(
        {
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
        {
          status: 'received',
          supplierId: '11111111-1111-4111-8111-111111111111',
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
      ),
    {
      message: 'Esta ordem de compra já foi recebida.',
    },
  )
})

test('mapReceiveItemsToOrderLines maps explicit order line ids and keeps within remaining balance', () => {
  const result = mapReceiveItemsToOrderLines({
    items: [
      {
        purchase_order_item_id: 'aaaa1111-1111-4111-8111-111111111111',
        product_id: 'bbbb1111-1111-4111-8111-111111111111',
        description: 'Produto A',
        quantity: 3,
        unit_cost: 10,
      },
    ],
    orderLines: [
      {
        purchaseOrderItemId: 'aaaa1111-1111-4111-8111-111111111111',
        productId: 'bbbb1111-1111-4111-8111-111111111111',
        description: 'Produto A',
        remainingQuantity: 5,
      },
    ],
  })

  assert.equal(result.mappedItems.length, 1)
  assert.equal(
    result.mappedItems[0].purchase_order_item_id,
    'aaaa1111-1111-4111-8111-111111111111',
  )
  assert.equal(result.receivedByLineId.get('aaaa1111-1111-4111-8111-111111111111'), 3)
})

test('mapReceiveItemsToOrderLines matches by product fallback when line id is omitted', () => {
  const result = mapReceiveItemsToOrderLines({
    items: [
      {
        product_id: 'bbbb1111-1111-4111-8111-111111111111',
        description: 'Produto A',
        quantity: 1,
        unit_cost: 10,
      },
    ],
    orderLines: [
      {
        purchaseOrderItemId: 'aaaa1111-1111-4111-8111-111111111111',
        productId: 'bbbb1111-1111-4111-8111-111111111111',
        description: 'Produto A',
        remainingQuantity: 5,
      },
    ],
  })

  assert.equal(
    result.mappedItems[0].purchase_order_item_id,
    'aaaa1111-1111-4111-8111-111111111111',
  )
})

test('mapReceiveItemsToOrderLines derives product from explicit order line id when product is omitted', () => {
  const result = mapReceiveItemsToOrderLines({
    items: [
      {
        purchase_order_item_id: 'aaaa1111-1111-4111-8111-111111111111',
        description: 'Produto sem id no payload',
        quantity: 1,
        unit_cost: 10,
      },
    ],
    orderLines: [
      {
        purchaseOrderItemId: 'aaaa1111-1111-4111-8111-111111111111',
        productId: 'bbbb1111-1111-4111-8111-111111111111',
        description: 'Produto A',
        remainingQuantity: 5,
      },
    ],
  })

  assert.equal(
    result.mappedItems[0].product_id,
    'bbbb1111-1111-4111-8111-111111111111',
  )
})

test('mapReceiveItemsToOrderLines rejects when order has no lines to receive', () => {
  assert.throws(
    () =>
      mapReceiveItemsToOrderLines({
        items: [
          {
            description: 'Produto A',
            quantity: 1,
            unit_cost: 10,
          },
        ],
        orderLines: [],
      }),
    {
      message: 'Ordem de compra não possui itens para recebimento.',
    },
  )
})

test('mapReceiveItemsToOrderLines rejects ambiguous fallback match by description', () => {
  assert.throws(
    () =>
      mapReceiveItemsToOrderLines({
        items: [
          {
            description: 'Produto sem SKU',
            quantity: 1,
            unit_cost: 10,
          },
        ],
        orderLines: [
          {
            purchaseOrderItemId: 'aaaa1111-1111-4111-8111-111111111111',
            productId: null,
            description: 'Produto sem SKU',
            remainingQuantity: 5,
          },
          {
            purchaseOrderItemId: 'cccc1111-1111-4111-8111-111111111111',
            productId: null,
            description: 'Produto sem SKU',
            remainingQuantity: 3,
          },
        ],
      }),
    {
      message:
        'Item 1: corresponde a múltiplas linhas da ordem. Recarregue a ordem para selecionar a linha correta.',
    },
  )
})

test('mapReceiveItemsToOrderLines rejects receiving above line remaining quantity', () => {
  assert.throws(
    () =>
      mapReceiveItemsToOrderLines({
        items: [
          {
            purchase_order_item_id: 'aaaa1111-1111-4111-8111-111111111111',
            product_id: 'bbbb1111-1111-4111-8111-111111111111',
            description: 'Produto A',
            quantity: 6,
            unit_cost: 10,
          },
        ],
        orderLines: [
          {
            purchaseOrderItemId: 'aaaa1111-1111-4111-8111-111111111111',
            productId: 'bbbb1111-1111-4111-8111-111111111111',
            description: 'Produto A',
            remainingQuantity: 5,
          },
        ],
      }),
    {
      message: 'Item 1: quantidade excede o saldo pendente da ordem de compra.',
    },
  )
})

test('resolveReceiveSupplierAndValidate blocks cancelled order receiving', () => {
  assert.throws(
    () =>
      resolveReceiveSupplierAndValidate(
        {
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
        {
          status: 'cancelled',
          supplierId: '11111111-1111-4111-8111-111111111111',
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
      ),
    {
      message: 'Ordem de compra cancelada não pode ser recebida.',
    },
  )
})

test('resolveReceiveSupplierAndValidate blocks draft order receiving', () => {
  assert.throws(
    () =>
      resolveReceiveSupplierAndValidate(
        {
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
        {
          status: 'draft',
          supplierId: '11111111-1111-4111-8111-111111111111',
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
      ),
    {
      message: 'Ordem de compra precisa estar aprovada para receber mercadorias.',
    },
  )
})

test('resolveReceiveSupplierAndValidate blocks supplier and warehouse mismatch', () => {
  assert.throws(
    () =>
      resolveReceiveSupplierAndValidate(
        {
          supplierId: '99999999-9999-4999-8999-999999999999',
          warehouseId: '88888888-8888-4888-8888-888888888888',
        },
        {
          status: 'approved',
          supplierId: '11111111-1111-4111-8111-111111111111',
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
      ),
    {
      message: 'Depósito do recebimento difere do depósito da ordem de compra.',
    },
  )
})

test('resolveReceiveSupplierAndValidate blocks supplier mismatch when warehouse matches', () => {
  assert.throws(
    () =>
      resolveReceiveSupplierAndValidate(
        {
          supplierId: '99999999-9999-4999-8999-999999999999',
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
        {
          status: 'approved',
          supplierId: '11111111-1111-4111-8111-111111111111',
          warehouseId: '22222222-2222-4222-8222-222222222222',
        },
      ),
    {
      message: 'Fornecedor do recebimento difere do fornecedor da ordem de compra.',
    },
  )
})
