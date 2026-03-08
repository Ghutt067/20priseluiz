import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { supabaseAdmin } from '../supabaseAdmin'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { createPurchaseOrder } from '../use-cases/core/createPurchaseOrder'
import { receivePurchase } from '../use-cases/core/receivePurchase'
import { createSalesOrder } from '../use-cases/core/createSalesOrder'
import { transferStock } from '../use-cases/core/transferStock'
import {
  STOCK_QTY_EPSILON,
  deductFromFreeStockRows,
  increaseNullBatchStockLevel,
  loadFreeStockRowsForUpdate,
  roundStockQty,
  sumFreeStock,
} from '../use-cases/core/stockLevelMutations'
import { faturarPedido } from '../use-cases/faturarPedido'
import { createShipment } from '../use-cases/shipping/createShipment'
import { dispatchShipment } from '../use-cases/shipping/dispatchShipment'
import { deliverShipment } from '../use-cases/shipping/deliverShipment'
import { recordAuditLog, runIdempotentMutation } from './mutationSafety'
import {
  mapReceiveItemsToOrderLines,
  purchaseOrderRequestSchema,
  purchaseReceiveRequestSchema,
  resolveReceiveSupplierAndValidate,
} from './purchasesValidation'

const router = Router()

const customerSchema = z.object({
  personType: z.enum(['legal', 'natural']),
  name: z.string().min(1),
  legalName: z.string().optional(),
  cpfCnpj: z.string().optional(),
  ie: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
})

const supplierSchema = customerSchema

const productSchema = z.object({
  sku: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  productType: z.enum(['product', 'service']).optional(),
  ncm: z.string().optional(),
  uom: z.string().optional(),
  price: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
})

const warehouseSchema = z.object({
  name: z.string().min(1),
})

type QuoteMeta = {
  validUntil: string | null
  createdAt: string
  freezePricing: boolean
  notes: string | null
}

type SalesWorkflowStage =
  | 'waiting_cashier'
  | 'waiting_packing'
  | 'packing'
  | 'ready_pickup'
  | 'picked_up'

type SalesWorkflowSnapshot = {
  orderId: string
  orderStatus: string
  totalAmount: number
  customerName: string
  stage: SalesWorkflowStage
  stageLabel: string
  shipmentId: string | null
  shipmentStatus: string | null
}

function parseQuoteMeta(notes: string | null): QuoteMeta {
  if (!notes) {
    return {
      validUntil: null,
      createdAt: new Date().toISOString(),
      freezePricing: true,
      notes: null,
    }
  }
  try {
    const parsed = JSON.parse(notes) as Partial<QuoteMeta>
    return {
      validUntil: parsed.validUntil ?? null,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      freezePricing: parsed.freezePricing ?? true,
      notes: parsed.notes ?? null,
    }
  } catch {
    return {
      validUntil: null,
      createdAt: new Date().toISOString(),
      freezePricing: true,
      notes,
    }
  }
}

function mapSalesWorkflowStage(orderStatus: string, shipmentStatus: string | null): {
  stage: SalesWorkflowStage
  stageLabel: string
} {
  if (shipmentStatus === 'delivered') {
    return { stage: 'picked_up', stageLabel: 'Retirada concluída' }
  }
  if (shipmentStatus === 'dispatched') {
    return { stage: 'ready_pickup', stageLabel: 'Pronto para retirada no balcão' }
  }
  if (shipmentStatus === 'pending') {
    return { stage: 'packing', stageLabel: 'Empacotador separando o pedido' }
  }
  if (orderStatus === 'invoiced') {
    return { stage: 'waiting_packing', stageLabel: 'Pagamento confirmado, aguardando empacotador' }
  }
  return { stage: 'waiting_cashier', stageLabel: 'Aguardando passagem no caixa' }
}

async function getSalesWorkflowSnapshot(
  client: PoolClient,
  organizationId: string,
  orderId: string,
): Promise<SalesWorkflowSnapshot> {
  const orderResult = await client.query(
    `select so.id, so.status, so.total_amount, c.name as customer_name
     from sales_orders so
     left join customers c on c.id = so.customer_id and c.organization_id = so.organization_id
     where so.organization_id = $1
       and so.id = $2`,
    [organizationId, orderId],
  )

  if ((orderResult.rowCount ?? 0) === 0) {
    throw new Error('Pedido não encontrado.')
  }

  const shipmentResult = await client.query(
    `select id, status
     from shipments
     where organization_id = $1
       and sales_order_id = $2
       and type = 'pickup'
       and status <> 'cancelled'
     order by created_at desc
     limit 1`,
    [organizationId, orderId],
  )

  const orderRow = orderResult.rows[0]
  const shipmentRow = shipmentResult.rows[0] as
    | { id: string; status: string }
    | undefined
  const orderStatus = (orderRow.status as string) ?? 'open'
  const shipmentStatus = shipmentRow?.status ?? null
  const mappedStage = mapSalesWorkflowStage(orderStatus, shipmentStatus)

  return {
    orderId: orderRow.id as string,
    orderStatus,
    totalAmount: Number(orderRow.total_amount ?? 0),
    customerName: (orderRow.customer_name as string | null) ?? 'Consumidor Padrão',
    stage: mappedStage.stage,
    stageLabel: mappedStage.stageLabel,
    shipmentId: shipmentRow?.id ?? null,
    shipmentStatus,
  }
}

// getAuthUser and assertOrgMember imported from authMiddleware

function normalizeOptionalQueryValue(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function parseBooleanQueryFlag(value: unknown) {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

type PurchaseOrderReceiveContextItem = {
  purchaseOrderItemId: string
  productId: string | null
  description: string
  quantity: number
  unitCost: number
  receivedQuantity: number
  remainingQuantity: number
}

type PurchaseOrderReceiveContext = {
  orderId: string
  status: string
  supplierId: string | null
  supplierName: string | null
  warehouseId: string | null
  warehouseName: string | null
  totalAmount: number
  notes: string | null
  items: PurchaseOrderReceiveContextItem[]
}

async function getPurchaseOrderReceiveContext(
  client: PoolClient,
  organizationId: string,
  orderId: string,
  options?: { lockForUpdate?: boolean },
): Promise<PurchaseOrderReceiveContext> {
  const lockForUpdate = options?.lockForUpdate === true
  const orderLockClause = lockForUpdate ? 'for update' : ''
  const itemsLockClause = lockForUpdate ? 'for update of poi' : ''

  const orderResult = await client.query(
    `select po.id,
            po.status,
            po.supplier_id,
            s.name as supplier_name,
            po.warehouse_id,
            w.name as warehouse_name,
            po.total_amount,
            po.notes
     from purchase_orders po
     left join suppliers s
            on s.id = po.supplier_id
           and s.organization_id = po.organization_id
     left join warehouses w
            on w.id = po.warehouse_id
           and w.organization_id = po.organization_id
     where po.organization_id = $1
       and po.id = $2
     limit 1
     ${orderLockClause}`,
    [organizationId, orderId],
  )

  if ((orderResult.rowCount ?? 0) === 0) {
    throw new Error('Ordem de compra informada não pertence à organização.')
  }

  const itemsResult = await client.query(
    `select poi.id as purchase_order_item_id,
            poi.product_id,
            poi.description,
            poi.quantity,
            poi.unit_cost,
            coalesce(received.received_quantity, 0)::numeric as received_quantity
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
     order by poi.id asc
     ${itemsLockClause}`,
    [organizationId, orderId],
  )

  const orderRow = orderResult.rows[0] as {
    id: string
    status: string
    supplier_id: string | null
    supplier_name: string | null
    warehouse_id: string | null
    warehouse_name: string | null
    total_amount: string | number | null
    notes: string | null
  }

  const items = itemsResult.rows.map((row) => {
    const quantity = Number(row.quantity ?? 0)
    const receivedQuantity = Number(row.received_quantity ?? 0)
    const remainingQuantity = Math.max(quantity - receivedQuantity, 0)
    return {
      purchaseOrderItemId: row.purchase_order_item_id as string,
      productId: (row.product_id as string | null) ?? null,
      description: (row.description as string | null) ?? '',
      quantity,
      unitCost: Number(row.unit_cost ?? 0),
      receivedQuantity,
      remainingQuantity,
    }
  })

  return {
    orderId: orderRow.id,
    status: orderRow.status,
    supplierId: orderRow.supplier_id,
    supplierName: orderRow.supplier_name,
    warehouseId: orderRow.warehouse_id,
    warehouseName: orderRow.warehouse_name,
    totalAmount: Number(orderRow.total_amount ?? 0),
    notes: orderRow.notes,
    items,
  }
}

router.get('/customers', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select id, name, legal_name, cpf_cnpj, email, phone, created_at
         from customers
         where organization_id = $1
         order by created_at desc`,
        [organizationId],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/customers/search', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const query =
      typeof request.query.query === 'string' ? request.query.query.trim().toLowerCase() : ''
    const parsedLimit = Number.parseInt(
      typeof request.query.limit === 'string' ? request.query.limit : '20',
      10,
    )
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 50)
      : 20
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0
    const likeQuery = `%${query}%`
    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      await client.query('select set_limit($1)', [0.1])

      const whereClause = `
        where c.organization_id = $1
          and (
            $2 = ''
            or c.name_search % unaccent($2)
            or c.phone_search % unaccent($2)
            or c.cpf_cnpj_search % unaccent($2)
            or c.name_search like unaccent($3)
            or c.phone_search like unaccent($3)
            or c.cpf_cnpj_search like unaccent($3)
          )`

      const primary = await client.query(
        `select
           c.id, c.name, c.email, c.phone, c.created_at,
           greatest(
             similarity(c.name_search, unaccent($2)),
             similarity(c.phone_search, unaccent($2)),
             similarity(c.cpf_cnpj_search, unaccent($2)),
             word_similarity(c.name_search, unaccent($2))
           ) as similarity_score,
           case
             when c.phone_search = unaccent($2) then 100
             when c.cpf_cnpj_search = unaccent($2) then 100
             when c.name_search like unaccent($3) then 70
             else 0
           end as exact_score
         from customers c
         ${whereClause}
         order by exact_score desc, similarity_score desc, c.name asc
         limit $4 offset $5`,
        [organizationId, query, likeQuery, limit, offset],
      )

      if (primary.rows.length > 0 || query.length < 3) {
        return primary
      }

      return client.query(
        `select c.id, c.name, c.email, c.phone, c.created_at
         from customers c
         where c.organization_id = $1
         order by
           greatest(
             similarity(c.name_search, unaccent($2)),
             similarity(c.phone_search, unaccent($2)),
             word_similarity(c.name_search, unaccent($2))
           ) desc,
           c.name asc
         limit $3 offset $4`,
        [organizationId, query, limit, offset],
      )
    })
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/customers', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const data = customerSchema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into customers
          (organization_id, person_type, name, legal_name, cpf_cnpj, ie, email, phone, active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, true)
         returning id`,
        [
          organizationId,
          data.personType,
          data.name,
          data.legalName ?? null,
          data.cpfCnpj ?? null,
          data.ie ?? null,
          data.email ?? null,
          data.phone ?? null,
        ],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/suppliers', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const query =
      typeof request.query.query === 'string'
        ? request.query.query.trim().toLowerCase()
        : ''
    const likeQuery = `%${query}%`
    const rawLimit = typeof request.query.limit === 'string' ? request.query.limit : null
    const parsedLimit = rawLimit === null ? Number.NaN : Number.parseInt(rawLimit, 10)
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : null
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0
    const result = await withOrgRead(organizationId, async (client) => {
      await client.query('select set_limit($1)', [0.1])

      const whereClause = `
        where s.organization_id = $1
          and (
            $2 = ''
            or s.name_search % unaccent($2)
            or s.legal_name_search % unaccent($2)
            or s.cpf_cnpj_search % unaccent($2)
            or s.name_search like unaccent($3)
            or s.legal_name_search like unaccent($3)
            or s.cpf_cnpj_search like unaccent($3)
          )`

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total from suppliers s ${whereClause}`,
        [organizationId, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           s.id, s.name, s.legal_name, s.cpf_cnpj, s.email, s.phone, s.created_at,
           greatest(
             similarity(s.name_search, unaccent($2)),
             similarity(s.legal_name_search, unaccent($2)),
             similarity(s.cpf_cnpj_search, unaccent($2)),
             word_similarity(s.name_search, unaccent($2)),
             word_similarity(s.legal_name_search, unaccent($2))
           ) as similarity_score,
           case
             when s.cpf_cnpj_search = unaccent($2) then 100
             when s.name_search like unaccent($3) then 70
             when s.legal_name_search like unaccent($3) then 60
             else 0
           end as exact_score
         from suppliers s
         ${whereClause}
         order by exact_score desc, similarity_score desc, s.name asc
         ${limit === null ? '' : 'limit $4 offset $5'}`,
        limit === null
          ? [organizationId, query, likeQuery]
          : [organizationId, query, likeQuery, limit, offset],
      )

      if (rowsResult.rows.length === 0 && query.length >= 3 && limit !== null) {
        const fallbackResult = await client.query(
          `select
             s.id, s.name, s.legal_name, s.cpf_cnpj, s.email, s.phone, s.created_at
           from suppliers s
           where s.organization_id = $1
           order by
             greatest(
               similarity(s.name_search, unaccent($2)),
               similarity(s.legal_name_search, unaccent($2)),
               word_similarity(s.name_search, unaccent($2)),
               word_similarity(s.legal_name_search, unaccent($2))
             ) desc,
             s.name asc
           limit $3 offset $4`,
          [organizationId, query, limit, offset],
        )
        return {
          rows: fallbackResult.rows,
          total: Number(countResult.rows[0]?.total ?? 0),
        }
      }

      const total = Number(countResult.rows[0]?.total ?? 0)
      return {
        rows: rowsResult.rows,
        total,
      }
    })
    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/suppliers', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const data = supplierSchema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into suppliers
          (organization_id, person_type, name, legal_name, cpf_cnpj, ie, email, phone, active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, true)
         returning id`,
        [
          organizationId,
          data.personType,
          data.name,
          data.legalName ?? null,
          data.cpfCnpj ?? null,
          data.ie ?? null,
          data.email ?? null,
          data.phone ?? null,
        ],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/products', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, (client) =>
      client.query(
        `select id, sku, name, product_type, price, cost, created_at
         from products
         where organization_id = $1
         order by created_at desc`,
        [organizationId],
      ),
    )
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/products/search', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const query =
      typeof request.query.query === 'string'
        ? request.query.query.trim().toLowerCase()
        : ''
    const warehouseId =
      typeof request.query.warehouseId === 'string'
        ? request.query.warehouseId.trim()
        : ''
    const parsedLimit = Number.parseInt(
      typeof request.query.limit === 'string' ? request.query.limit : '30',
      10,
    )
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 50)
      : 30
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0
    const likeQuery = `%${query}%`

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      await client.query('select set_limit($1)', [0.1])
      const primary = await client.query(
        `
        select
          p.id,
          p.sku,
          p.name,
          p.brand,
          p.barcode,
          p.image_url,
          p.price,
          p.cost,
          coalesce(sum(sl.qty_available - sl.qty_reserved), 0) as stock_available,
          greatest(
            similarity(p.name_search, unaccent($3)),
            similarity(p.sku_search, unaccent($3)),
            similarity(p.brand_search, unaccent($3)),
            similarity(p.barcode_search, unaccent($3)),
            word_similarity(p.name_search, unaccent($3)),
            word_similarity(p.brand_search, unaccent($3))
          ) as similarity_score,
          case
            when p.barcode_search = unaccent($3) then 100
            when p.sku_search = unaccent($3) then 90
            when p.name_search like unaccent($4) then 70
            when p.brand_search like unaccent($4) then 60
            else 0
          end as exact_score
        from products p
        left join stock_levels sl
          on sl.product_id = p.id
         and sl.organization_id = p.organization_id
         and ($2 = '' or sl.warehouse_id::text = $2)
        where p.organization_id = $1
          and (
            $3 = '' or
            p.name_search % unaccent($3) or
            p.sku_search % unaccent($3) or
            p.brand_search % unaccent($3) or
            p.barcode_search % unaccent($3) or
            p.name_search like unaccent($4) or
            p.sku_search like unaccent($4) or
            p.brand_search like unaccent($4) or
            p.barcode_search like unaccent($4)
          )
        group by p.id
        order by
          exact_score desc,
          similarity_score desc,
          p.name asc
        limit $5
        offset $6
        `,
        [organizationId, warehouseId, query, likeQuery, limit, offset],
      )

      const primaryTotalResult = await client.query<{ total: number }>(
        `
        select count(*)::int as total
        from products p
        where p.organization_id = $1
          and (
            $2 = '' or
            p.name_search % unaccent($2) or
            p.sku_search % unaccent($2) or
            p.brand_search % unaccent($2) or
            p.barcode_search % unaccent($2) or
            p.name_search like unaccent($3) or
            p.sku_search like unaccent($3) or
            p.brand_search like unaccent($3) or
            p.barcode_search like unaccent($3)
          )
        `,
        [organizationId, query, likeQuery],
      )
      const primaryTotal = Number(primaryTotalResult.rows[0]?.total ?? 0)

      if (primary.rows.length > 0 || query.length < 3) {
        return {
          rows: primary.rows,
          total: primaryTotal,
        }
      }

      const fallback = await client.query(
        `
        select
          p.id,
          p.sku,
          p.name,
          p.brand,
          p.barcode,
          p.image_url,
          p.price,
          p.cost,
          coalesce(sum(sl.qty_available - sl.qty_reserved), 0) as stock_available
        from products p
        left join stock_levels sl
          on sl.product_id = p.id
         and sl.organization_id = p.organization_id
         and ($2 = '' or sl.warehouse_id::text = $2)
        where p.organization_id = $1
        group by p.id
        order by
          greatest(
            similarity(p.name_search, unaccent($3)),
            similarity(p.sku_search, unaccent($3)),
            similarity(p.brand_search, unaccent($3)),
            similarity(p.barcode_search, unaccent($3)),
            word_similarity(p.name_search, unaccent($3)),
            word_similarity(p.brand_search, unaccent($3))
          ) desc,
          p.name asc
        limit $4
        offset $5
        `,
        [organizationId, warehouseId, query, limit, offset],
      )

      const fallbackTotalResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from products
         where organization_id = $1`,
        [organizationId],
      )
      const fallbackTotal = Number(fallbackTotalResult.rows[0]?.total ?? 0)

      return {
        rows: fallback.rows,
        total: fallbackTotal,
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/products', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const data = productSchema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into products
          (organization_id, sku, name, description, product_type, ncm, uom, price, cost, active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
         returning id`,
        [
          organizationId,
          data.sku ?? null,
          data.name,
          data.description ?? null,
          data.productType ?? 'product',
          data.ncm ?? null,
          data.uom ?? 'UN',
          data.price ?? 0,
          data.cost ?? 0,
        ],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/warehouses', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const query =
      typeof request.query.query === 'string'
        ? request.query.query.trim().toLowerCase()
        : ''
    const likeQuery = `%${query}%`
    const rawLimit = typeof request.query.limit === 'string' ? request.query.limit : null
    const parsedLimit = rawLimit === null ? Number.NaN : Number.parseInt(rawLimit, 10)
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : null
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0
    const result = await withOrgRead(organizationId, async (client) => {
      await client.query('select set_limit($1)', [0.1])

      const whereClause = `
        where w.organization_id = $1
          and (
            $2 = ''
            or w.name_search % unaccent($2)
            or w.name_search like unaccent($3)
          )`

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total from warehouses w ${whereClause}`,
        [organizationId, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           w.id, w.name, w.created_at,
           greatest(
             similarity(w.name_search, unaccent($2)),
             word_similarity(w.name_search, unaccent($2))
           ) as similarity_score,
           case
             when w.name_search like unaccent($3) then 70
             else 0
           end as exact_score
         from warehouses w
         ${whereClause}
         order by exact_score desc, similarity_score desc, w.name asc
         ${limit === null ? '' : 'limit $4 offset $5'}`,
        limit === null
          ? [organizationId, query, likeQuery]
          : [organizationId, query, likeQuery, limit, offset],
      )

      if (rowsResult.rows.length === 0 && query.length >= 3 && limit !== null) {
        const fallbackResult = await client.query(
          `select w.id, w.name, w.created_at
           from warehouses w
           where w.organization_id = $1
           order by
             greatest(
               similarity(w.name_search, unaccent($2)),
               word_similarity(w.name_search, unaccent($2))
             ) desc,
             w.name asc
           limit $3 offset $4`,
          [organizationId, query, limit, offset],
        )
        return {
          rows: fallbackResult.rows,
          total: Number(countResult.rows[0]?.total ?? 0),
        }
      }

      const total = Number(countResult.rows[0]?.total ?? 0)
      return {
        rows: rowsResult.rows,
        total,
      }
    })
    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/warehouses', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const data = warehouseSchema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into warehouses (organization_id, name)
         values ($1, $2)
         returning id`,
        [organizationId, data.name],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/sales/defaults', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      const profile = await client.query(
        `select full_name, email from profiles where id = $1`,
        [user.id],
      )
      const profileRow = profile.rows[0]
      const agentName =
        profileRow?.full_name ?? profileRow?.email ?? 'Vendedor'

      let warehouseId: string
      const warehouseResult = await client.query(
        `select id from warehouses where organization_id = $1 order by created_at asc limit 1`,
        [organizationId],
      )
      if (warehouseResult.rowCount === 0) {
        const created = await client.query(
          `insert into warehouses (organization_id, name) values ($1, $2) returning id`,
          [organizationId, 'Depósito Padrão'],
        )
        warehouseId = created.rows[0].id
      } else {
        warehouseId = warehouseResult.rows[0].id
      }

      let customerId: string
      const customerResult = await client.query(
        `select id from customers where organization_id = $1 order by created_at asc limit 1`,
        [organizationId],
      )
      if (customerResult.rowCount === 0) {
        const created = await client.query(
          `insert into customers
            (organization_id, person_type, name, active)
           values ($1, 'natural', 'Consumidor Padrão', true)
           returning id`,
          [organizationId],
        )
        customerId = created.rows[0].id
      } else {
        customerId = customerResult.rows[0].id
      }

      const agentResult = await client.query(
        `select id from sales_agents where organization_id = $1 and id = $2`,
        [organizationId, user.id],
      )
      if (agentResult.rowCount === 0) {
        await client.query(
          `insert into sales_agents (id, organization_id, name) values ($1, $2, $3)`,
          [user.id, organizationId, agentName],
        )
      }

      const productsCount = await client.query(
        `select count(*)::int as total from products where organization_id = $1`,
        [organizationId],
      )
      if ((productsCount.rows[0]?.total ?? 0) === 0) {
        const sampleProducts = [
          { name: 'Produto Teste 1', sku: 'TEST-001', price: 19.9 },
          { name: 'Produto Teste 2', sku: 'TEST-002', price: 39.9 },
          { name: 'Produto Teste 3', sku: 'TEST-003', price: 59.9 },
        ]
        for (const product of sampleProducts) {
          const productResult = await client.query(
            `insert into products
              (organization_id, sku, name, product_type, uom, price, cost, active)
             values ($1, $2, $3, 'product', 'UN', $4, 0, true)
             returning id`,
            [organizationId, product.sku, product.name, product.price],
          )
          const productId = productResult.rows[0].id
          await increaseNullBatchStockLevel({
            client,
            organizationId,
            productId,
            warehouseId,
            quantity: 100,
          })
        }
      }

      return {
        customerId,
        warehouseId,
        salesAgentId: user.id,
      }
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/purchases/orders', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const data = purchaseOrderRequestSchema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'purchase_order_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const supplierResult = await client.query(
            `select 1
             from suppliers
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, data.supplierId],
          )
          if ((supplierResult.rowCount ?? 0) === 0) {
            throw new Error('Fornecedor informado não pertence à organização.')
          }

          const warehouseResult = await client.query(
            `select 1
             from warehouses
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, data.warehouseId],
          )
          if ((warehouseResult.rowCount ?? 0) === 0) {
            throw new Error('Depósito informado não pertence à organização.')
          }

          const productIds = Array.from(
            new Set(data.items.map((item) => item.product_id).filter((id): id is string => Boolean(id))),
          )

          if (productIds.length > 0) {
            const productsResult = await client.query(
              `select id
               from products
               where organization_id = $1
                 and id = any($2::uuid[])`,
              [organizationId, productIds],
            )
            if (productsResult.rows.length !== productIds.length) {
              throw new Error('Produto informado na compra não foi encontrado na organização.')
            }
          }

          const result = await createPurchaseOrder(client, {
            organizationId,
            supplierId: data.supplierId,
            warehouseId: data.warehouseId,
            notes: data.notes ?? null,
            items: data.items,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'purchase_orders',
            recordId: result.orderId,
            newData: {
              orderId: result.orderId,
              supplierId: data.supplierId,
              warehouseId: data.warehouseId,
              totalAmount: result.totalAmount,
              itemsCount: data.items.length,
            },
            metadata: {
              source: 'core.purchases.order.create',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/purchases/orders/search', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const query =
      typeof request.query.query === 'string'
        ? request.query.query.trim().toLowerCase()
        : ''
    const includeReceived = request.query.includeReceived === 'true'
    const parsedLimit = Number.parseInt(
      typeof request.query.limit === 'string' ? request.query.limit : '15',
      10,
    )
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 30)
      : 15
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0
    const likeQuery = `%${query}%`

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return client.query(
        `select
          po.id,
          po.status,
          po.created_at,
          po.total_amount,
          po.supplier_id,
          s.name as supplier_name,
          po.warehouse_id,
          w.name as warehouse_name,
          coalesce(pending.pending_lines, 0)::int as pending_lines,
          coalesce(pending.pending_quantity, 0)::numeric as pending_quantity
        from purchase_orders po
        left join suppliers s
          on s.id = po.supplier_id
         and s.organization_id = po.organization_id
        left join warehouses w
          on w.id = po.warehouse_id
         and w.organization_id = po.organization_id
        left join lateral (
          select
            count(*) filter (
              where greatest(poi.quantity - coalesce(received.received_quantity, 0), 0) > 0.000001
            ) as pending_lines,
            sum(greatest(poi.quantity - coalesce(received.received_quantity, 0), 0)) as pending_quantity
          from purchase_order_items poi
          left join (
            select
              pri.purchase_order_item_id,
              sum(pri.quantity)::numeric as received_quantity
            from purchase_receipt_items pri
            inner join purchase_receipts pr
              on pr.id = pri.purchase_receipt_id
             and pr.organization_id = pri.organization_id
            where pri.organization_id = $1
              and pr.purchase_order_id = po.id
              and pr.status <> 'cancelled'
              and pri.purchase_order_item_id is not null
            group by pri.purchase_order_item_id
          ) received on received.purchase_order_item_id = poi.id
          where poi.organization_id = po.organization_id
            and poi.purchase_order_id = po.id
        ) pending on true
        where po.organization_id = $1
          and po.status <> 'cancelled'
          and ($2::boolean or po.status <> 'received')
          and (
            $3 = ''
            or po.id::text ilike $4
            or smart_search_match(coalesce(s.name_search, lower(unaccent(coalesce(s.name, '')))), $3, $4)
            or smart_search_match(coalesce(w.name_search, lower(unaccent(coalesce(w.name, '')))), $3, $4)
          )
        order by
          case
            when po.status = 'approved' then 0
            when po.status = 'draft' then 1
            when po.status = 'received' then 2
            else 3
          end,
          greatest(
            smart_search_score(coalesce(s.name_search, lower(unaccent(coalesce(s.name, '')))), $3, $4),
            smart_search_score(coalesce(w.name_search, lower(unaccent(coalesce(w.name, '')))), $3, $4)
          ) desc,
          po.created_at desc
        limit $5
        offset $6`,
        [organizationId, includeReceived, query, likeQuery, limit, offset],
      )
    })

    response.json(
      result.rows.map((row) => ({
        id: row.id as string,
        status: row.status as string,
        createdAt: row.created_at as string,
        totalAmount: Number(row.total_amount ?? 0),
        supplierId: (row.supplier_id as string | null) ?? null,
        supplierName: (row.supplier_name as string | null) ?? null,
        warehouseId: (row.warehouse_id as string | null) ?? null,
        warehouseName: (row.warehouse_name as string | null) ?? null,
        pendingLines: Number(row.pending_lines ?? 0),
        pendingQuantity: Number(row.pending_quantity ?? 0),
      })),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.patch('/purchases/orders/:orderId/approve', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, async (client) => {
      const updated = await client.query(
        `update purchase_orders set status = 'approved'
         where organization_id = $1 and id = $2 and status = 'draft' returning id`,
        [organizationId, request.params.orderId],
      )
      if ((updated.rowCount ?? 0) === 0) throw new Error('Ordem não encontrada ou não está em rascunho.')
      return { orderId: request.params.orderId }
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/purchases/orders/:orderId/cancel', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, async (client) => {
      const updated = await client.query(
        `update purchase_orders set status = 'cancelled'
         where organization_id = $1 and id = $2 and status in ('draft', 'approved') returning id`,
        [organizationId, request.params.orderId],
      )
      if ((updated.rowCount ?? 0) === 0) throw new Error('Ordem não encontrada ou não pode ser cancelada.')
      return { orderId: request.params.orderId }
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/purchases/orders/:orderId/receive-context', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const orderId = z.string().uuid().parse(request.params.orderId)

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return getPurchaseOrderReceiveContext(client, organizationId, orderId)
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/purchases/receive', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const data = purchaseReceiveRequestSchema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'purchase_receive',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          let previousOrderStatus: string | null = null
          let nextOrderStatus: string | null = null
          let resolvedSupplierId: string
          let receiveItems = data.items
          if (data.purchaseOrderId) {
            const orderContext = await getPurchaseOrderReceiveContext(
              client,
              organizationId,
              data.purchaseOrderId,
              { lockForUpdate: true },
            )
            const resolved = resolveReceiveSupplierAndValidate(
              {
                supplierId: data.supplierId,
                warehouseId: data.warehouseId,
              },
              {
                status: orderContext.status,
                supplierId: orderContext.supplierId,
                warehouseId: orderContext.warehouseId,
              },
            )

            const mapped = mapReceiveItemsToOrderLines({
              items: data.items,
              orderLines: orderContext.items.map((line) => ({
                purchaseOrderItemId: line.purchaseOrderItemId,
                productId: line.productId,
                description: line.description,
                remainingQuantity: line.remainingQuantity,
              })),
            })

            previousOrderStatus = resolved.previousOrderStatus
            resolvedSupplierId = resolved.resolvedSupplierId
            receiveItems = mapped.mappedItems
            nextOrderStatus = orderContext.items.every((line) => {
              const receivedInRequest = mapped.receivedByLineId.get(line.purchaseOrderItemId) ?? 0
              return line.remainingQuantity - receivedInRequest <= 0.000001
            })
              ? 'received'
              : 'approved'
          } else {
            if (data.items.some((item) => Boolean(item.purchase_order_item_id))) {
              throw new Error('Linha da ordem de compra só pode ser informada quando houver ordem vinculada.')
            }
            const resolved = resolveReceiveSupplierAndValidate(
              {
                supplierId: data.supplierId,
                warehouseId: data.warehouseId,
              },
              null,
            )
            resolvedSupplierId = resolved.resolvedSupplierId
          }

          const supplierResult = await client.query(
            `select 1
             from suppliers
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, resolvedSupplierId],
          )
          if ((supplierResult.rowCount ?? 0) === 0) {
            throw new Error('Fornecedor informado não pertence à organização.')
          }

          const warehouseResult = await client.query(
            `select 1
             from warehouses
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, data.warehouseId],
          )
          if ((warehouseResult.rowCount ?? 0) === 0) {
            throw new Error('Depósito informado não pertence à organização.')
          }

          const productIds = Array.from(
            new Set(receiveItems.map((item) => item.product_id).filter((id): id is string => Boolean(id))),
          )

          if (productIds.length > 0) {
            const productsResult = await client.query(
              `select id
               from products
               where organization_id = $1
                 and id = any($2::uuid[])`,
              [organizationId, productIds],
            )
            if (productsResult.rows.length !== productIds.length) {
              throw new Error('Produto informado no recebimento não foi encontrado na organização.')
            }
          }

          const result = await receivePurchase(client, {
            organizationId,
            purchaseOrderId: data.purchaseOrderId ?? null,
            supplierId: resolvedSupplierId,
            warehouseId: data.warehouseId,
            notes: data.notes ?? null,
            items: receiveItems,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'purchase_receipts',
            recordId: result.receiptId,
            newData: {
              receiptId: result.receiptId,
              purchaseOrderId: data.purchaseOrderId ?? null,
              supplierId: resolvedSupplierId,
              warehouseId: data.warehouseId,
              totalAmount: result.totalAmount,
              itemsCount: data.items.length,
            },
            metadata: {
              source: 'core.purchases.receive',
            },
          })

          if (data.purchaseOrderId) {
            await recordAuditLog({
              client,
              organizationId,
              actorUserId: user.id,
              operation: 'update',
              tableName: 'purchase_orders',
              recordId: data.purchaseOrderId,
              oldData: {
                status: previousOrderStatus,
              },
              newData: {
                status: nextOrderStatus ?? 'approved',
              },
              metadata: {
                source: 'core.purchases.receive.order',
                receiptId: result.receiptId,
              },
            })
          }

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/sales/orders', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
    })

    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100)
    const offset = Math.max(Number(request.query.offset) || 0, 0)
    const statusFilter = typeof request.query.status === 'string' ? request.query.status.trim() : ''
    const query = typeof request.query.query === 'string' ? request.query.query.trim() : ''
    const dateFrom = typeof request.query.dateFrom === 'string' ? request.query.dateFrom.trim() : ''
    const dateTo = typeof request.query.dateTo === 'string' ? request.query.dateTo.trim() : ''

    const conditions: string[] = ['so.organization_id = $1']
    const params: unknown[] = [organizationId]
    let paramIndex = 2

    if (statusFilter) {
      const statuses = statusFilter.split(',').map((s: string) => s.trim()).filter(Boolean)
      if (statuses.length === 1) {
        conditions.push(`so.status = $${paramIndex}`)
        params.push(statuses[0])
        paramIndex++
      } else if (statuses.length > 1) {
        const placeholders = statuses.map((_: string, i: number) => `$${paramIndex + i}`).join(', ')
        conditions.push(`so.status in (${placeholders})`)
        params.push(...statuses)
        paramIndex += statuses.length
      }
    }
    if (query) {
      const qi = paramIndex
      const li = paramIndex + 1
      conditions.push(`(smart_search_match(coalesce(c.name_search, lower(unaccent(coalesce(c.name, '')))), $${qi}, $${li}) or so.id::text ilike $${li} or exists (select 1 from sales_order_items soi left join products p on p.id = soi.product_id where soi.sales_order_id = so.id and (smart_search_match(coalesce(p.name_search, lower(unaccent(coalesce(p.name, '')))), $${qi}, $${li}) or smart_search_match(lower(unaccent(coalesce(soi.description, ''))), $${qi}, $${li}))))`)
      params.push(query, `%${query}%`)
      paramIndex += 2
    }
    if (dateFrom) {
      conditions.push(`so.created_at >= $${paramIndex}::timestamptz`)
      params.push(dateFrom)
      paramIndex++
    }
    if (dateTo) {
      conditions.push(`so.created_at <= ($${paramIndex}::date + interval '1 day')`)
      params.push(dateTo)
      paramIndex++
    }

    const where = conditions.join(' and ')

    const result = await withOrgRead(organizationId, async (client) => {
      const countResult = await client.query(
        `select count(*)::int as total from sales_orders so left join customers c on c.id = so.customer_id where ${where}`,
        params,
      )
      const total = countResult.rows[0]?.total ?? 0

      const dataResult = await client.query(
        `select
           so.id,
           so.status,
           so.total_amount::numeric as "totalAmount",
           so.notes,
           so.created_at as "createdAt",
           so.updated_at as "updatedAt",
           so.customer_id as "customerId",
           coalesce(c.name, 'Consumidor') as "customerName",
           so.warehouse_id as "warehouseId"
         from sales_orders so
         left join customers c on c.id = so.customer_id
         where ${where}
         order by so.created_at desc
         limit $${paramIndex} offset $${paramIndex + 1}`,
        [...params, limit, offset],
      )

      return { rows: dataResult.rows.map((r: Record<string, unknown>) => ({ ...r, totalAmount: Number(r.totalAmount) })), total }
    })

    response.setHeader('x-total-count', String(result.total))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/sales/orders', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      customerId: z.string().uuid().optional(),
      warehouseId: z.string().uuid().optional(),
      salesAgentId: z.string().uuid().optional(),
      notes: z.string().optional(),
      paymentCondition: z.string().optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      items: z.array(
        z.object({
          product_id: z.string().uuid().optional(),
          description: z.string().min(1),
          quantity: z.number().positive(),
          unit_price: z.number().nonnegative(),
          ncm: z.string().optional(),
          cfop: z.string().optional(),
        }),
      ).min(1, 'Pedido deve ter pelo menos um item.'),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      if (data.discountPercent && data.discountPercent > 0) {
        const limitRow = await client.query(
          `select max_discount_percent::numeric as "maxDiscount"
           from discount_limits
           where organization_id = $1 and role_key = (
             select role::text from organization_users where organization_id = $1 and user_id = $2 limit 1
           )`,
          [organizationId, user.id],
        )
        if ((limitRow.rowCount ?? 0) > 0) {
          const maxDiscount = Number(limitRow.rows[0].maxDiscount)
          if (data.discountPercent > maxDiscount) {
            throw new Error(`Desconto de ${data.discountPercent}% excede o limite permitido de ${maxDiscount}% para o seu perfil.`)
          }
        }
      }

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'sales_order_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const result = await createSalesOrder(client, {
            organizationId,
            customerId: data.customerId ?? null,
            warehouseId: data.warehouseId ?? null,
            salesAgentId: data.salesAgentId ?? null,
            notes: data.notes ?? null,
            paymentCondition: data.paymentCondition ?? null,
            discountPercent: data.discountPercent ?? 0,
            items: data.items,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'sales_orders',
            recordId: result.orderId,
            newData: {
              orderId: result.orderId,
              customerId: data.customerId ?? null,
              warehouseId: data.warehouseId ?? null,
              salesAgentId: data.salesAgentId ?? null,
              totalAmount: result.totalAmount,
              itemsCount: data.items.length,
            },
            metadata: {
              source: 'core.sales.orders.create',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/sales/orders/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      const orderRow = await client.query(
        `select so.id, so.status, so.total_amount::numeric as "totalAmount",
                so.notes,
                so.customer_id as "customerId",
                coalesce(c.name, 'Consumidor Padrão') as "customerName",
                so.warehouse_id as "warehouseId",
                so.sales_agent_id as "salesAgentId",
                so.created_at as "createdAt", so.updated_at as "updatedAt"
         from sales_orders so
         left join customers c on c.id = so.customer_id
         where so.organization_id = $1 and so.id = $2`,
        [organizationId, request.params.id],
      )
      if ((orderRow.rowCount ?? 0) === 0) throw new Error('Pedido não encontrado.')
      const order = orderRow.rows[0]

      const itemsResult = await client.query(
        `select id, product_id as "productId", description, quantity::numeric as quantity,
                unit_price::numeric as "unitPrice", total_price::numeric as "totalPrice",
                ncm, cfop
         from sales_order_items
         where sales_order_id = $1
         order by id`,
        [request.params.id],
      )

      return { ...order, items: itemsResult.rows }
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.put('/sales/orders/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const orderId = request.params.id

    const schema = z.object({
      customerId: z.string().uuid().optional(),
      notes: z.string().optional(),
      paymentCondition: z.string().optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      status: z.enum(['open', 'pending', 'cancelled']).optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const existing = await client.query(
        `select id, status from sales_orders where organization_id = $1 and id = $2`,
        [organizationId, orderId],
      )
      if ((existing.rowCount ?? 0) === 0) throw new Error('Pedido não encontrado.')
      const currentStatus = existing.rows[0].status as string
      if (currentStatus === 'invoiced' || currentStatus === 'delivered') {
        throw new Error('Pedido já faturado/entregue não pode ser editado.')
      }

      if (data.discountPercent && data.discountPercent > 0) {
        const limitRow = await client.query(
          `select max_discount_percent::numeric as "maxDiscount"
           from discount_limits
           where organization_id = $1 and role_key = (
             select role::text from organization_users where organization_id = $1 and user_id = $2 limit 1
           )`,
          [organizationId, user.id],
        )
        if ((limitRow.rowCount ?? 0) > 0) {
          const maxDiscount = Number(limitRow.rows[0].maxDiscount)
          if (data.discountPercent > maxDiscount) {
            throw new Error(`Desconto de ${data.discountPercent}% excede o limite de ${maxDiscount}%.`)
          }
        }
      }

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'sales_order_update',
        idempotencyKey,
        requestBody: { orderId, ...data },
        execute: async () => {
          const sets: string[] = ['updated_at = now()', 'updated_by = $3']
          const params: unknown[] = [organizationId, orderId, user.id]
          let paramIndex = 4

          if (data.customerId !== undefined) {
            sets.push(`customer_id = $${paramIndex}`)
            params.push(data.customerId)
            paramIndex += 1
          }
          if (data.notes !== undefined) {
            sets.push(`notes = $${paramIndex}`)
            params.push(data.notes)
            paramIndex += 1
          }
          if (data.paymentCondition !== undefined) {
            sets.push(`payment_condition = $${paramIndex}`)
            params.push(data.paymentCondition)
            paramIndex += 1
          }
          if (data.discountPercent !== undefined) {
            sets.push(`discount_percent = $${paramIndex}`)
            params.push(data.discountPercent)
            paramIndex += 1
          }
          if (data.status !== undefined) {
            sets.push(`status = $${paramIndex}`)
            params.push(data.status)
            paramIndex += 1
          }

          await client.query(
            `update sales_orders set ${sets.join(', ')} where organization_id = $1 and id = $2`,
            params,
          )

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'sales_orders',
            recordId: orderId,
            newData: data,
            metadata: { source: 'core.sales.orders.update' },
          })

          return { status: 200 as const, body: { orderId, updated: true } }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/sales/orders/:id/workflow', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))

    const workflow = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return getSalesWorkflowSnapshot(client, organizationId, request.params.id)
    })

    response.json(workflow)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/sales/orders/:id/invoice', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'sales_order_invoice',
        idempotencyKey,
        requestBody: { orderId: request.params.id },
        execute: async () => {
          const workflowBefore = await getSalesWorkflowSnapshot(
            client,
            organizationId,
            request.params.id,
          )
          const invoice = await faturarPedido(client, { salesOrderId: request.params.id })
          const workflow = await getSalesWorkflowSnapshot(client, organizationId, request.params.id)

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'sales_orders',
            recordId: request.params.id,
            oldData: {
              orderStatus: workflowBefore.orderStatus,
              stage: workflowBefore.stage,
              shipmentStatus: workflowBefore.shipmentStatus,
            },
            newData: {
              orderStatus: workflow.orderStatus,
              stage: workflow.stage,
              shipmentStatus: workflow.shipmentStatus,
              invoiceId: invoice.invoiceId,
              fiscalDocumentId: invoice.fiscalDocumentId,
            },
            metadata: {
              source: 'core.sales.orders.invoice',
            },
          })

          return {
            status: 201,
            body: {
              ...invoice,
              workflow,
            },
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/sales/orders/:id/pickup', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'sales_order_pickup_create',
        idempotencyKey,
        requestBody: { orderId: request.params.id },
        execute: async () => {
          const workflowBefore = await getSalesWorkflowSnapshot(client, organizationId, request.params.id)

          if (workflowBefore.orderStatus !== 'invoiced') {
            throw new Error('Pedido precisa passar pelo caixa antes de ir para empacotamento.')
          }

          if (workflowBefore.stage === 'picked_up') {
            throw new Error('Retirada deste pedido já foi concluída.')
          }

          if (workflowBefore.shipmentId) {
            const workflow = await getSalesWorkflowSnapshot(client, organizationId, request.params.id)
            return {
              status: 201,
              body: {
                shipmentId: workflowBefore.shipmentId,
                reused: true,
                workflow,
              },
            }
          }

          const orderResult = await client.query(
            `select customer_id
             from sales_orders
             where organization_id = $1
               and id = $2`,
            [organizationId, request.params.id],
          )

          if ((orderResult.rowCount ?? 0) === 0) {
            throw new Error('Pedido não encontrado para gerar retirada.')
          }

          const itemsResult = await client.query(
            `select product_id, quantity
             from sales_order_items
             where organization_id = $1
               and sales_order_id = $2
               and quantity > 0`,
            [organizationId, request.params.id],
          )

          if ((itemsResult.rowCount ?? 0) === 0) {
            throw new Error('Pedido sem itens não pode ser enviado para empacotamento.')
          }

          const shipment = await createShipment(client, {
            organizationId,
            salesOrderId: request.params.id,
            customerId: (orderResult.rows[0].customer_id as string | null) ?? null,
            type: 'pickup',
            carrier: null,
            trackingCode: null,
            items: itemsResult.rows.map((item) => ({
              product_id: (item.product_id as string | null) ?? null,
              quantity: Number(item.quantity ?? 0),
            })),
          })

          const workflow = await getSalesWorkflowSnapshot(client, organizationId, request.params.id)

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'shipments',
            recordId: shipment.shipmentId,
            newData: {
              shipmentId: shipment.shipmentId,
              salesOrderId: request.params.id,
              status: workflow.shipmentStatus,
            },
            metadata: {
              source: 'core.sales.orders.pickup.create',
            },
          })

          return {
            status: 201,
            body: {
              shipmentId: shipment.shipmentId,
              reused: false,
              workflow,
            },
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/sales/orders/:id/pickup/dispatch', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'sales_order_pickup_dispatch',
        idempotencyKey,
        requestBody: { orderId: request.params.id },
        execute: async () => {
          const shipmentResult = await client.query(
            `select id, status
             from shipments
             where organization_id = $1
               and sales_order_id = $2
               and type = 'pickup'
               and status <> 'cancelled'
             order by created_at desc
             limit 1`,
            [organizationId, request.params.id],
          )

          if ((shipmentResult.rowCount ?? 0) === 0) {
            throw new Error('Nenhuma retirada encontrada. Gere a etapa de empacotamento primeiro.')
          }

          const shipment = shipmentResult.rows[0] as { id: string; status: string }
          const previousStatus = shipment.status
          if (shipment.status === 'pending') {
            await dispatchShipment(client, {
              organizationId,
              shipmentId: shipment.id,
            })
          }

          const workflow = await getSalesWorkflowSnapshot(client, organizationId, request.params.id)

          if (previousStatus !== workflow.shipmentStatus) {
            await recordAuditLog({
              client,
              organizationId,
              actorUserId: user.id,
              operation: 'update',
              tableName: 'shipments',
              recordId: shipment.id,
              oldData: {
                status: previousStatus,
              },
              newData: {
                status: workflow.shipmentStatus,
                stage: workflow.stage,
              },
              metadata: {
                source: 'core.sales.orders.pickup.dispatch',
                salesOrderId: request.params.id,
              },
            })
          }

          return {
            status: 201,
            body: {
              shipmentId: shipment.id,
              workflow,
            },
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/sales/orders/:id/pickup/deliver', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'sales_order_pickup_deliver',
        idempotencyKey,
        requestBody: { orderId: request.params.id },
        execute: async () => {
          const shipmentResult = await client.query(
            `select id, status
             from shipments
             where organization_id = $1
               and sales_order_id = $2
               and type = 'pickup'
               and status <> 'cancelled'
             order by created_at desc
             limit 1`,
            [organizationId, request.params.id],
          )

          if ((shipmentResult.rowCount ?? 0) === 0) {
            throw new Error('Nenhuma retirada encontrada. Gere a etapa de empacotamento primeiro.')
          }

          const shipment = shipmentResult.rows[0] as { id: string; status: string }
          const previousStatus = shipment.status
          if (shipment.status === 'pending') {
            await dispatchShipment(client, {
              organizationId,
              shipmentId: shipment.id,
            })
          }
          if (shipment.status !== 'delivered') {
            await deliverShipment(client, {
              organizationId,
              shipmentId: shipment.id,
            })
          }

          const workflow = await getSalesWorkflowSnapshot(client, organizationId, request.params.id)

          if (previousStatus !== workflow.shipmentStatus) {
            await recordAuditLog({
              client,
              organizationId,
              actorUserId: user.id,
              operation: 'update',
              tableName: 'shipments',
              recordId: shipment.id,
              oldData: {
                status: previousStatus,
              },
              newData: {
                status: workflow.shipmentStatus,
                stage: workflow.stage,
              },
              metadata: {
                source: 'core.sales.orders.pickup.deliver',
                salesOrderId: request.params.id,
              },
            })
          }

          return {
            status: 201,
            body: {
              shipmentId: shipment.id,
              workflow,
            },
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/quotes', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      customerId: z.uuid().optional(),
      notes: z.string().optional(),
      validUntil: z.iso.datetime().optional(),
      items: z.array(
        z.object({
          product_id: z.uuid().optional(),
          description: z.string().min(1),
          quantity: z.number().positive(),
          unit_price: z.number().nonnegative(),
        }),
      ).min(1, 'Cotação deve ter pelo menos um item.'),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'quote_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          if (data.customerId) {
            const customerResult = await client.query(
              `select 1
               from customers
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.customerId],
            )
            if ((customerResult.rowCount ?? 0) === 0) {
              throw new Error('Cliente informado não pertence à organização.')
            }
          }

          const productIds = Array.from(
            new Set(data.items.map((item) => item.product_id).filter((id): id is string => Boolean(id))),
          )
          if (productIds.length > 0) {
            const productsResult = await client.query(
              `select id
               from products
               where organization_id = $1
                 and id = any($2::uuid[])`,
              [organizationId, productIds],
            )
            if (productsResult.rows.length !== productIds.length) {
              throw new Error('Produto informado na cotação não foi encontrado na organização.')
            }
          }

          const items = data.items.map((item) => ({
            ...item,
            total_price: Number((item.quantity * item.unit_price).toFixed(2)),
          }))
          const totalAmount = items.reduce((sum, item) => sum + item.total_price, 0)

          const meta: QuoteMeta = {
            validUntil: data.validUntil ?? null,
            createdAt: new Date().toISOString(),
            freezePricing: true,
            notes: data.notes ?? null,
          }

          const quoteResult = await client.query(
            `insert into quotes
              (organization_id, customer_id, status, total_amount, notes)
             values ($1, $2, 'draft', $3, $4)
             returning id`,
            [organizationId, data.customerId ?? null, totalAmount, JSON.stringify(meta)],
          )

          const quoteId = quoteResult.rows[0].id as string

          for (const item of items) {
            await client.query(
              `insert into quote_items
                (organization_id, quote_id, product_id, description, quantity, unit_price, total_price)
               values ($1, $2, $3, $4, $5, $6, $7)`,
              [
                organizationId,
                quoteId,
                item.product_id ?? null,
                item.description,
                item.quantity,
                item.unit_price,
                item.total_price,
              ],
            )
          }

          const result = {
            quoteId,
            totalAmount,
            status: 'draft',
            validUntil: meta.validUntil,
          }

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'quotes',
            recordId: quoteId,
            newData: {
              quoteId,
              status: 'draft',
              totalAmount,
              customerId: data.customerId ?? null,
              validUntil: meta.validUntil,
              itemsCount: items.length,
            },
            metadata: {
              source: 'core.quotes.create',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/quotes/recent', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const limit = Math.min(Math.max(Number(request.query.limit ?? 10), 1), 50)
    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return client.query(
        `select
           q.id,
           q.status,
           q.total_amount,
           q.created_at,
           q.notes,
           c.name as customer_name
         from quotes q
         left join customers c on c.id = q.customer_id and c.organization_id = q.organization_id
         where q.organization_id = $1
         order by q.created_at desc
         limit $2`,
        [organizationId, limit],
      )
    })

    response.json(
      result.rows.map((row) => {
        const meta = parseQuoteMeta((row.notes as string | null) ?? null)
        return {
          id: row.id as string,
          status: row.status as string,
          totalAmount: Number(row.total_amount ?? 0),
          customerName: (row.customer_name as string | null) ?? 'Consumidor Padrão',
          createdAt: row.created_at as string,
          validUntil: meta.validUntil,
        }
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/quotes/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      const quoteRow = await client.query(
        `select q.id, q.status, q.total_amount::numeric as "totalAmount",
                q.notes,
                q.customer_id as "customerId",
                coalesce(c.name, 'Consumidor Padrão') as "customerName",
                q.created_at as "createdAt"
         from quotes q
         left join customers c on c.id = q.customer_id
         where q.organization_id = $1 and q.id = $2`,
        [organizationId, request.params.id],
      )
      if ((quoteRow.rowCount ?? 0) === 0) throw new Error('Cotação não encontrada.')
      const quote = quoteRow.rows[0]

      const itemsResult = await client.query(
        `select id, product_id as "productId", description,
                quantity::numeric as quantity,
                unit_price::numeric as "unitPrice",
                total_price::numeric as "totalPrice"
         from quote_items
         where quote_id = $1 and organization_id = $2
         order by id`,
        [request.params.id, organizationId],
      )

      return { ...quote, items: itemsResult.rows }
    })
    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/quotes/:id/cancel', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'quote_cancel',
        idempotencyKey,
        requestBody: { quoteId: request.params.id },
        execute: async () => {
          const quoteResult = await client.query(
            `select id, status
             from quotes
             where id = $1
               and organization_id = $2
             for update`,
            [request.params.id, organizationId],
          )
          if (quoteResult.rowCount === 0) {
            throw new Error('Cotação não encontrada.')
          }
          const status = quoteResult.rows[0].status as string
          if (status === 'converted') {
            throw new Error('Cotação convertida não pode ser cancelada.')
          }
          if (status === 'cancelled') {
            return {
              status: 200,
              body: { id: request.params.id, status: 'cancelled' },
            }
          }

          await client.query(
            `update quotes set status = 'cancelled', updated_at = now() where id = $1 and organization_id = $2`,
            [request.params.id, organizationId],
          )

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'quotes',
            recordId: request.params.id,
            oldData: {
              status,
            },
            newData: {
              status: 'cancelled',
            },
            metadata: {
              source: 'core.quotes.cancel',
            },
          })

          return {
            status: 200,
            body: { id: request.params.id, status: 'cancelled' },
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/quotes/:id/duplicate', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'quote_duplicate',
        idempotencyKey,
        requestBody: { quoteId: request.params.id },
        execute: async () => {
          const quoteResult = await client.query(
            `select id, customer_id, notes
             from quotes
             where id = $1 and organization_id = $2`,
            [request.params.id, organizationId],
          )

          if (quoteResult.rowCount === 0) {
            throw new Error('Cotação não encontrada.')
          }

          const originalQuote = quoteResult.rows[0]
          const originalMeta = parseQuoteMeta((originalQuote.notes as string | null) ?? null)
          const newMeta: QuoteMeta = {
            validUntil: null,
            createdAt: new Date().toISOString(),
            freezePricing: originalMeta.freezePricing,
            notes: originalMeta.notes,
          }

          const quoteItemsResult = await client.query(
            `select product_id, description, quantity, unit_price
             from quote_items
             where quote_id = $1 and organization_id = $2
             order by id asc`,
            [request.params.id, organizationId],
          )

          if (quoteItemsResult.rowCount === 0) {
            throw new Error('Cotação sem itens não pode ser duplicada.')
          }

          const newTotal = quoteItemsResult.rows.reduce((sum, item) => {
            const quantity = Number(item.quantity ?? 0)
            const unitPrice = Number(item.unit_price ?? 0)
            return sum + quantity * unitPrice
          }, 0)

          const newQuoteResult = await client.query(
            `insert into quotes
              (organization_id, customer_id, status, total_amount, notes)
             values ($1, $2, 'draft', $3, $4)
             returning id`,
            [organizationId, originalQuote.customer_id ?? null, newTotal, JSON.stringify(newMeta)],
          )
          const newQuoteId = newQuoteResult.rows[0].id as string

          for (const item of quoteItemsResult.rows) {
            const quantity = Number(item.quantity ?? 0)
            const unitPrice = Number(item.unit_price ?? 0)
            const totalPrice = Number((quantity * unitPrice).toFixed(2))
            await client.query(
              `insert into quote_items
                (organization_id, quote_id, product_id, description, quantity, unit_price, total_price)
               values ($1, $2, $3, $4, $5, $6, $7)`,
              [
                organizationId,
                newQuoteId,
                (item.product_id as string | null) ?? null,
                item.description as string,
                quantity,
                unitPrice,
                totalPrice,
              ],
            )
          }

          const duplicated = {
            quoteId: newQuoteId,
            totalAmount: Number(newTotal.toFixed(2)),
            status: 'draft',
          }

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'quotes',
            recordId: newQuoteId,
            newData: {
              quoteId: newQuoteId,
              status: 'draft',
              totalAmount: duplicated.totalAmount,
              sourceQuoteId: request.params.id,
              itemsCount: quoteItemsResult.rowCount,
            },
            metadata: {
              source: 'core.quotes.duplicate',
              sourceQuoteId: request.params.id,
            },
          })

          return {
            status: 201,
            body: duplicated,
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/quotes/:id/convert', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      warehouseId: z.uuid().optional(),
      forceConfirm: z.boolean().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation<{
        reviewRequired: boolean
        message: string
        divergences: Array<{
          productId: string | null
          description: string
          type: 'price' | 'stock'
          quoted: number
          current: number
        }>
        orderId?: string
      }>({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'quote_convert',
        idempotencyKey,
        requestBody: {
          quoteId: request.params.id,
          warehouseId: data.warehouseId ?? null,
          forceConfirm: data.forceConfirm ?? false,
        },
        execute: async () => {
          if (data.warehouseId) {
            const warehouseResult = await client.query(
              `select 1
               from warehouses
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.warehouseId],
            )
            if ((warehouseResult.rowCount ?? 0) === 0) {
              throw new Error('Depósito informado não pertence à organização.')
            }
          }

          const quoteResult = await client.query(
            `select id, customer_id, total_amount, status, notes
             from quotes
             where id = $1
               and organization_id = $2
             for update`,
            [request.params.id, organizationId],
          )

          if (quoteResult.rowCount === 0) {
            throw new Error('Cotação não encontrada.')
          }

          const quote = quoteResult.rows[0] as {
            id: string
            customer_id: string | null
            total_amount: number
            status: string
            notes: string | null
          }
          const previousStatus = quote.status
          const meta = parseQuoteMeta(quote.notes)
          const now = new Date()
          const validUntilDate = meta.validUntil ? new Date(meta.validUntil) : null

          if (previousStatus === 'converted') {
            throw new Error('Cotação já foi convertida.')
          }
          if (previousStatus === 'cancelled') {
            throw new Error('Cotação cancelada não pode ser convertida.')
          }
          if (previousStatus === 'expired') {
            throw new Error('Cotação vencida. Gere uma nova cotação ou atualize a validade.')
          }
          if (validUntilDate && !Number.isNaN(validUntilDate.getTime()) && now > validUntilDate) {
            await client.query(
              `update quotes
               set status = 'expired', updated_at = now()
               where id = $1
                 and organization_id = $2`,
              [quote.id, organizationId],
            )

            await recordAuditLog({
              client,
              organizationId,
              actorUserId: user.id,
              operation: 'update',
              tableName: 'quotes',
              recordId: quote.id,
              oldData: {
                status: previousStatus,
              },
              newData: {
                status: 'expired',
              },
              metadata: {
                source: 'core.quotes.convert.expire',
              },
            })

            throw new Error('Cotação vencida. Gere uma nova cotação ou atualize a validade.')
          }

          const itemsResult = await client.query(
            `select product_id, description, quantity, unit_price, total_price
             from quote_items
             where quote_id = $1
               and organization_id = $2`,
            [quote.id, organizationId],
          )

          const quoteItems = itemsResult.rows as Array<{
            product_id: string | null
            description: string
            quantity: number
            unit_price: number
            total_price: number
          }>

          if (quoteItems.length === 0) {
            throw new Error('Cotação sem itens não pode ser convertida.')
          }

          const divergences: Array<{
            productId: string | null
            description: string
            type: 'price' | 'stock'
            quoted: number
            current: number
          }> = []

          for (const item of quoteItems) {
            if (!item.product_id) continue
            const productPriceResult = await client.query(
              `select price from products where organization_id = $1 and id = $2`,
              [organizationId, item.product_id],
            )
            if ((productPriceResult.rowCount ?? 0) > 0) {
              const currentPrice = Number(productPriceResult.rows[0].price ?? 0)
              const quotedPrice = Number(item.unit_price ?? 0)
              if (Math.abs(currentPrice - quotedPrice) >= 0.01) {
                divergences.push({
                  productId: item.product_id,
                  description: item.description,
                  type: 'price',
                  quoted: quotedPrice,
                  current: currentPrice,
                })
              }
            }
            if (data.warehouseId) {
              const stockResult = await client.query(
                `select coalesce(sum(qty_available - qty_reserved), 0) as qty
                 from stock_levels
                 where organization_id = $1
                   and product_id = $2
                   and warehouse_id = $3`,
                [organizationId, item.product_id, data.warehouseId],
              )
              const currentStock = Number(stockResult.rows[0]?.qty ?? 0)
              const needed = Number(item.quantity ?? 0)
              if (currentStock < needed) {
                divergences.push({
                  productId: item.product_id,
                  description: item.description,
                  type: 'stock',
                  quoted: needed,
                  current: currentStock,
                })
              }
            }
          }

          if (divergences.length > 0 && !data.forceConfirm) {
            return {
              status: 409,
              body: {
                reviewRequired: true,
                message:
                  'A cotação possui divergências de preço/estoque. Confirme para converter mesmo assim.',
                divergences,
              },
            }
          }

          const createdOrder = await createSalesOrder(client, {
            organizationId,
            customerId: quote.customer_id ?? null,
            quoteId: quote.id,
            warehouseId: data.warehouseId ?? null,
            notes: meta.notes,
            items: quoteItems.map((item) => ({
              product_id: item.product_id ?? undefined,
              description: item.description,
              quantity: Number(item.quantity ?? 0),
              unit_price: Number(item.unit_price ?? 0),
            })),
          })

          const orderId = createdOrder.orderId

          await client.query(
            `update quotes
             set status = 'converted', updated_at = now()
             where id = $1
               and organization_id = $2`,
            [quote.id, organizationId],
          )

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'sales_orders',
            recordId: orderId,
            newData: {
              orderId,
              quoteId: quote.id,
              totalAmount: createdOrder.totalAmount,
              customerId: quote.customer_id,
              warehouseId: data.warehouseId ?? null,
            },
            metadata: {
              source: 'core.quotes.convert.order',
            },
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'quotes',
            recordId: quote.id,
            oldData: {
              status: previousStatus,
            },
            newData: {
              status: 'converted',
              orderId,
              divergencesCount: divergences.length,
            },
            metadata: {
              source: 'core.quotes.convert',
            },
          })

          return {
            status: 201,
            body: {
              orderId,
              reviewRequired: false,
              message: 'Cotação convertida com sucesso.',
              divergences,
            },
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/stock/levels', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const productId = normalizeOptionalQueryValue(request.query.productId)
    const warehouseId = normalizeOptionalQueryValue(request.query.warehouseId)
    const query = normalizeOptionalQueryValue(request.query.query).toLowerCase()
    const likeQuery = `%${query}%`
    const onlyAlerts = parseBooleanQueryFlag(request.query.onlyAlerts)
    const parsedLimit = Number.parseInt(
      typeof request.query.limit === 'string' ? request.query.limit : '50',
      10,
    )
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 50
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `with grouped as (
           select sl.product_id,
                  sl.warehouse_id
             from stock_levels sl
             join products p
               on p.id = sl.product_id
              and p.organization_id = sl.organization_id
             join warehouses w
               on w.id = sl.warehouse_id
              and w.organization_id = sl.organization_id
            where sl.organization_id = $1
              and ($2 = '' or sl.product_id::text = $2)
              and ($3 = '' or sl.warehouse_id::text = $3)
              and (
                $4 = ''
                or p.name_search like unaccent($5)
                or p.sku_search like unaccent($5)
              )
            group by sl.product_id, sl.warehouse_id
            having (
              $6 = false
              or coalesce(sum(sl.qty_available), 0) < coalesce(sum(sl.min_qty), 0)
              or coalesce(sum(sl.qty_reserved), 0) > coalesce(sum(sl.qty_available), 0)
            )
         )
         select count(*)::int as total
           from grouped`,
        [organizationId, productId, warehouseId, query, likeQuery, onlyAlerts],
      )

      const rowsResult = await client.query(
        `select
           sl.product_id as "productId",
           p.name as "productName",
           p.sku as "productSku",
           sl.warehouse_id as "warehouseId",
           w.name as "warehouseName",
           coalesce(sum(sl.qty_available), 0)::numeric as "qtyAvailable",
           coalesce(sum(sl.qty_reserved), 0)::numeric as "qtyReserved",
           (coalesce(sum(sl.qty_available), 0) - coalesce(sum(sl.qty_reserved), 0))::numeric as "qtyFree",
           coalesce(sum(sl.min_qty), 0)::numeric as "minQty",
           coalesce(sum(sl.max_qty), 0)::numeric as "maxQty",
           (coalesce(sum(sl.qty_available), 0) < coalesce(sum(sl.min_qty), 0)) as "belowMin",
           (coalesce(sum(sl.qty_reserved), 0) > coalesce(sum(sl.qty_available), 0)) as "inconsistent"
         from stock_levels sl
         join products p
           on p.id = sl.product_id
          and p.organization_id = sl.organization_id
         join warehouses w
           on w.id = sl.warehouse_id
          and w.organization_id = sl.organization_id
        where sl.organization_id = $1
          and ($2 = '' or sl.product_id::text = $2)
          and ($3 = '' or sl.warehouse_id::text = $3)
          and (
            $4 = ''
            or p.name_search like unaccent($5)
            or p.sku_search like unaccent($5)
          )
        group by sl.product_id, p.name, p.sku, sl.warehouse_id, w.name
        having (
          $6 = false
          or coalesce(sum(sl.qty_available), 0) < coalesce(sum(sl.min_qty), 0)
          or coalesce(sum(sl.qty_reserved), 0) > coalesce(sum(sl.qty_available), 0)
        )
        order by p.name asc, w.name asc
        limit $7
        offset $8`,
        [organizationId, productId, warehouseId, query, likeQuery, onlyAlerts, limit, offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/stock/movements', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const productId = normalizeOptionalQueryValue(request.query.productId)
    const warehouseId = normalizeOptionalQueryValue(request.query.warehouseId)
    const movementType = normalizeOptionalQueryValue(request.query.movementType).toLowerCase()
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const query = normalizeOptionalQueryValue(request.query.query).toLowerCase()
    const likeQuery = `%${query}%`

    if (movementType) {
      const allowedMovementTypes = new Set(['in', 'out', 'adjust', 'transfer'])
      if (!allowedMovementTypes.has(movementType)) {
        throw new Error('Tipo de movimento inválido.')
      }
    }

    const parsedLimit = Number.parseInt(
      typeof request.query.limit === 'string' ? request.query.limit : '50',
      10,
    )
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 50
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
           from stock_movements sm
           join products p
             on p.id = sm.product_id
            and p.organization_id = sm.organization_id
           join warehouses w
             on w.id = sm.warehouse_id
            and w.organization_id = sm.organization_id
          where sm.organization_id = $1
            and ($2 = '' or sm.product_id::text = $2)
            and ($3 = '' or sm.warehouse_id::text = $3)
            and (
              $4 = ''
              or (
                case
                  when sm.ref_table = 'stock_transfers' or sm.movement_type::text = 'transfer'
                  then 'transfer'
                  else sm.movement_type::text
                end
              ) = $4
            )
            and ($5 = '' or sm.occurred_at >= $5::timestamptz)
            and ($6 = '' or sm.occurred_at <= $6::timestamptz)
            and (
              $7 = ''
              or smart_search_match(p.name_search, $7, $8)
              or smart_search_match(p.sku_search, $7, $8)
              or smart_search_match(lower(unaccent(coalesce(sm.reason, ''))), $7, $8)
            )`,
        [organizationId, productId, warehouseId, movementType, from, to, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           sm.id,
           sm.product_id as "productId",
           p.name as "productName",
           p.sku as "productSku",
           sm.warehouse_id as "warehouseId",
           w.name as "warehouseName",
           case
             when sm.ref_table = 'stock_transfers' or sm.movement_type::text = 'transfer'
             then 'transfer'
             else sm.movement_type::text
           end as "movementType",
           sm.quantity as quantity,
           sm.reason as reason,
           sm.ref_table as "refTable",
           sm.ref_id as "refId",
           sm.occurred_at as "occurredAt"
         from stock_movements sm
         join products p
           on p.id = sm.product_id
          and p.organization_id = sm.organization_id
         join warehouses w
           on w.id = sm.warehouse_id
          and w.organization_id = sm.organization_id
        where sm.organization_id = $1
          and ($2 = '' or sm.product_id::text = $2)
          and ($3 = '' or sm.warehouse_id::text = $3)
          and (
            $4 = ''
            or (
              case
                when sm.ref_table = 'stock_transfers' or sm.movement_type::text = 'transfer'
                then 'transfer'
                else sm.movement_type::text
              end
            ) = $4
          )
          and ($5 = '' or sm.occurred_at >= $5::timestamptz)
          and ($6 = '' or sm.occurred_at <= $6::timestamptz)
          and (
            $7 = ''
            or smart_search_match(p.name_search, $7, $8)
            or smart_search_match(p.sku_search, $7, $8)
            or smart_search_match(lower(unaccent(coalesce(sm.reason, ''))), $7, $8)
          )
        order by sm.occurred_at desc, sm.id desc
        limit $9
        offset $10`,
        [organizationId, productId, warehouseId, movementType, from, to, query, likeQuery, limit, offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/stock/replenishment/suggestions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const productId = normalizeOptionalQueryValue(request.query.productId)
    const warehouseId = normalizeOptionalQueryValue(request.query.warehouseId)
    const query = normalizeOptionalQueryValue(request.query.query).toLowerCase()
    const likeQuery = `%${query}%`

    const parsedLimit = Number.parseInt(
      typeof request.query.limit === 'string' ? request.query.limit : '50',
      10,
    )
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 50
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `with grouped as (
           select sl.product_id,
                  sl.warehouse_id
             from stock_levels sl
             join products p
               on p.id = sl.product_id
              and p.organization_id = sl.organization_id
             join warehouses w
               on w.id = sl.warehouse_id
              and w.organization_id = sl.organization_id
            where sl.organization_id = $1
              and ($2 = '' or sl.product_id::text = $2)
              and ($3 = '' or sl.warehouse_id::text = $3)
              and (
                $4 = ''
                or p.name_search like unaccent($5)
                or p.sku_search like unaccent($5)
              )
            group by sl.product_id, sl.warehouse_id
            having coalesce(sum(sl.qty_available), 0) < coalesce(sum(sl.min_qty), 0)
         )
         select count(*)::int as total
           from grouped`,
        [organizationId, productId, warehouseId, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           sl.product_id as "productId",
           p.name as "productName",
           p.sku as "productSku",
           sl.warehouse_id as "warehouseId",
           w.name as "warehouseName",
           coalesce(sum(sl.qty_available), 0)::numeric as "qtyAvailable",
           coalesce(sum(sl.qty_reserved), 0)::numeric as "qtyReserved",
           (coalesce(sum(sl.qty_available), 0) - coalesce(sum(sl.qty_reserved), 0))::numeric as "qtyFree",
           coalesce(sum(sl.min_qty), 0)::numeric as "minQty",
           coalesce(sum(sl.max_qty), 0)::numeric as "maxQty",
           greatest(
             coalesce(sum(sl.max_qty), 0) - coalesce(sum(sl.qty_available), 0),
             coalesce(sum(sl.min_qty), 0) - coalesce(sum(sl.qty_available), 0),
             0
           )::numeric as "qtyToReplenish"
         from stock_levels sl
         join products p
           on p.id = sl.product_id
          and p.organization_id = sl.organization_id
         join warehouses w
           on w.id = sl.warehouse_id
          and w.organization_id = sl.organization_id
        where sl.organization_id = $1
          and ($2 = '' or sl.product_id::text = $2)
          and ($3 = '' or sl.warehouse_id::text = $3)
          and (
            $4 = ''
            or p.name_search like unaccent($5)
            or p.sku_search like unaccent($5)
          )
        group by sl.product_id, p.name, p.sku, sl.warehouse_id, w.name
        having coalesce(sum(sl.qty_available), 0) < coalesce(sum(sl.min_qty), 0)
        order by "qtyToReplenish" desc, p.name asc, w.name asc
        limit $6
        offset $7`,
        [organizationId, productId, warehouseId, query, likeQuery, limit, offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/stock/levels/minmax', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z
      .object({
        productId: z.string().uuid(),
        warehouseId: z.string().uuid(),
        minQty: z.number().nonnegative(),
        maxQty: z.number().nonnegative(),
      })
      .refine(
        (value) => value.maxQty + STOCK_QTY_EPSILON >= value.minQty,
        'Estoque máximo deve ser maior ou igual ao mínimo.',
      )
    const data = schema.parse(request.body)
    const minQty = roundStockQty(data.minQty)
    const maxQty = roundStockQty(data.maxQty)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'stock_level_minmax_update',
        idempotencyKey,
        requestBody: {
          ...data,
          minQty,
          maxQty,
        },
        execute: async () => {
          const warehouseResult = await client.query(
            `select 1
             from warehouses
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, data.warehouseId],
          )
          if ((warehouseResult.rowCount ?? 0) === 0) {
            throw new Error('Depósito informado não pertence à organização.')
          }

          const productResult = await client.query(
            `select 1
             from products
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, data.productId],
          )
          if ((productResult.rowCount ?? 0) === 0) {
            throw new Error('Produto informado não pertence à organização.')
          }

          const upsertResult = await client.query(
            `insert into stock_levels
              (organization_id, product_id, warehouse_id, batch_id, qty_available, qty_reserved, min_qty, max_qty, updated_at)
             values ($1, $2, $3, null, 0, 0, $4, $5, now())
             on conflict (organization_id, product_id, warehouse_id)
               where batch_id is null
             do update
               set min_qty = excluded.min_qty,
                   max_qty = excluded.max_qty,
                   updated_at = now()
             returning id`,
            [organizationId, data.productId, data.warehouseId, minQty, maxQty],
          )

          const stockLevelId = upsertResult.rows[0].id as string
          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'stock_levels',
            recordId: stockLevelId,
            newData: {
              productId: data.productId,
              warehouseId: data.warehouseId,
              minQty,
              maxQty,
            },
            metadata: {
              source: 'core.stock.level.minmax',
            },
          })

          return {
            status: 201,
            body: {
              productId: data.productId,
              warehouseId: data.warehouseId,
              minQty,
              maxQty,
            },
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/stock/adjustments', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      warehouseId: z.string().uuid(),
      adjustmentType: z.enum(['in', 'out', 'adjust']),
      reason: z.string().optional(),
      items: z.array(
        z.object({
          product_id: z.string().uuid(),
          quantity: z.number(),
        }),
      ).min(1, 'Ajuste de estoque precisa ter ao menos um item.'),
    })
    const data = schema.parse(request.body)
    const normalizedReason = data.reason?.trim() ?? ''
    const normalizedItems = data.items.map((item, index) => {
      const quantity = roundStockQty(Number(item.quantity ?? 0))

      if (data.adjustmentType === 'adjust') {
        if (Math.abs(quantity) <= STOCK_QTY_EPSILON) {
          throw new Error(`Item ${index + 1}: ajuste deve ser diferente de zero.`)
        }
      } else if (quantity <= STOCK_QTY_EPSILON) {
        throw new Error(`Item ${index + 1}: quantidade deve ser maior que zero.`)
      }

      return {
        product_id: item.product_id,
        quantity,
      }
    })

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'stock_adjustment_create',
        idempotencyKey,
        requestBody: {
          warehouseId: data.warehouseId,
          adjustmentType: data.adjustmentType,
          reason: normalizedReason || null,
          items: normalizedItems,
        },
        execute: async () => {
          const warehouseResult = await client.query(
            `select id
             from warehouses
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, data.warehouseId],
          )
          if ((warehouseResult.rowCount ?? 0) === 0) {
            throw new Error('Depósito informado não pertence à organização.')
          }

          const productIds = Array.from(new Set(normalizedItems.map((item) => item.product_id)))
          const productsResult = await client.query(
            `select id
             from products
             where organization_id = $1
               and id = any($2::uuid[])`,
            [organizationId, productIds],
          )
          if (productsResult.rows.length !== productIds.length) {
            throw new Error('Produto informado não pertence à organização.')
          }

          const adjustmentIdResult = await client.query<{ id: string }>(
            `select gen_random_uuid() as id`,
          )
          const adjustmentId = adjustmentIdResult.rows[0].id

          let adjustedItems = 0
          let totalDelta = 0

          for (const item of normalizedItems) {
            let movementType: 'in' | 'out' | 'adjust' = data.adjustmentType
            let movementQuantity = item.quantity
            let delta = 0

            if (data.adjustmentType === 'in') {
              const quantity = roundStockQty(Math.abs(item.quantity))
              await increaseNullBatchStockLevel({
                client,
                organizationId,
                productId: item.product_id,
                warehouseId: data.warehouseId,
                quantity,
              })
              movementType = 'in'
              movementQuantity = quantity
              delta = quantity
            } else if (data.adjustmentType === 'out') {
              const quantity = roundStockQty(Math.abs(item.quantity))
              const stockRows = await loadFreeStockRowsForUpdate({
                client,
                organizationId,
                warehouseId: data.warehouseId,
                productId: item.product_id,
              })
              const freeQty = sumFreeStock(stockRows)
              if (freeQty + STOCK_QTY_EPSILON < quantity) {
                throw new Error(
                  `Ajuste manual sem saldo livre suficiente. Produto ${item.product_id.slice(0, 8)}: livre ${freeQty.toFixed(4)} | solicitado ${quantity.toFixed(4)}.`,
                )
              }

              const remainingToReduce = await deductFromFreeStockRows({
                client,
                rows: stockRows,
                quantity,
              })
              if (remainingToReduce > STOCK_QTY_EPSILON) {
                throw new Error(
                  `Falha ao reduzir saldo do produto ${item.product_id.slice(0, 8)} durante ajuste manual.`,
                )
              }

              movementType = 'out'
              movementQuantity = quantity
              delta = -quantity
            } else {
              movementType = 'adjust'
              movementQuantity = item.quantity

              if (item.quantity > 0) {
                await increaseNullBatchStockLevel({
                  client,
                  organizationId,
                  productId: item.product_id,
                  warehouseId: data.warehouseId,
                  quantity: item.quantity,
                })
              } else {
                const quantityToReduce = roundStockQty(Math.abs(item.quantity))
                const stockRows = await loadFreeStockRowsForUpdate({
                  client,
                  organizationId,
                  warehouseId: data.warehouseId,
                  productId: item.product_id,
                })
                const freeQty = sumFreeStock(stockRows)
                if (freeQty + STOCK_QTY_EPSILON < quantityToReduce) {
                  throw new Error(
                    `Ajuste manual sem saldo livre suficiente. Produto ${item.product_id.slice(0, 8)}: livre ${freeQty.toFixed(4)} | solicitado ${quantityToReduce.toFixed(4)}.`,
                  )
                }

                const remainingToReduce = await deductFromFreeStockRows({
                  client,
                  rows: stockRows,
                  quantity: quantityToReduce,
                })
                if (remainingToReduce > STOCK_QTY_EPSILON) {
                  throw new Error(
                    `Falha ao reduzir saldo do produto ${item.product_id.slice(0, 8)} durante ajuste manual.`,
                  )
                }
              }

              delta = item.quantity
            }

            const reason =
              normalizedReason ||
              (movementType === 'in'
                ? 'Ajuste manual de entrada'
                : movementType === 'out'
                  ? 'Ajuste manual de saída'
                  : 'Ajuste manual')

            await client.query(
              `insert into stock_movements
                (organization_id, product_id, warehouse_id, movement_type, quantity, reason, ref_table, ref_id)
               values ($1, $2, $3, $4, $5, $6, 'stock_adjustments', $7)`,
              [
                organizationId,
                item.product_id,
                data.warehouseId,
                movementType,
                movementQuantity,
                reason,
                adjustmentId,
              ],
            )

            totalDelta = roundStockQty(totalDelta + delta)
            adjustedItems += 1
          }

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'stock_adjustments',
            recordId: adjustmentId,
            newData: {
              adjustmentId,
              warehouseId: data.warehouseId,
              adjustmentType: data.adjustmentType,
              reason: normalizedReason || null,
              adjustedItems,
              totalDelta,
            },
            metadata: {
              source: 'core.stock.adjustments.create',
            },
          })

          return {
            status: 201,
            body: {
              adjustmentId,
              adjustedItems,
              totalDelta,
            },
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/stock/transfers', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      originWarehouseId: z.string().uuid(),
      destinationWarehouseId: z.string().uuid(),
      notes: z.string().optional(),
      items: z.array(
        z.object({
          product_id: z.string().uuid(),
          quantity: z.number().positive(),
        }),
      ).min(1, 'Transferência precisa ter ao menos um item.'),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'stock_transfer_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const warehouseIds = Array.from(
            new Set([data.originWarehouseId, data.destinationWarehouseId]),
          )
          const warehousesResult = await client.query(
            `select id
             from warehouses
             where organization_id = $1
               and id = any($2::uuid[])`,
            [organizationId, warehouseIds],
          )
          if (warehousesResult.rows.length !== warehouseIds.length) {
            throw new Error('Depósito informado não pertence à organização.')
          }

          const productIds = Array.from(
            new Set(data.items.map((item) => item.product_id).filter((id): id is string => Boolean(id))),
          )
          const productsResult = await client.query(
            `select id
             from products
             where organization_id = $1
               and id = any($2::uuid[])`,
            [organizationId, productIds],
          )
          if (productsResult.rows.length !== productIds.length) {
            throw new Error('Produto informado não pertence à organização.')
          }

          const result = await transferStock(client, {
            organizationId,
            originWarehouseId: data.originWarehouseId,
            destinationWarehouseId: data.destinationWarehouseId,
            notes: data.notes ?? null,
            items: data.items,
          })

          const totalQuantity = data.items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0)
          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'stock_transfers',
            recordId: result.transferId,
            newData: {
              transferId: result.transferId,
              originWarehouseId: data.originWarehouseId,
              destinationWarehouseId: data.destinationWarehouseId,
              itemsCount: data.items.length,
              totalQuantity: Number(totalQuantity.toFixed(4)),
            },
            metadata: {
              source: 'core.stock.transfer.create',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    if (mutation.replayed) {
      response.setHeader('x-idempotent-replay', 'true')
    }

    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

// ===== CRUD update/deactivate endpoints for Cadastros =====

router.put('/customers/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const data = customerSchema.partial().parse(request.body)
    const setClauses: string[] = []
    const values: unknown[] = [organizationId, request.params.id]
    let idx = 3

    if (data.name !== undefined) { setClauses.push(`name = $${idx++}`); values.push(data.name) }
    if (data.personType !== undefined) { setClauses.push(`person_type = $${idx++}`); values.push(data.personType) }
    if (data.legalName !== undefined) { setClauses.push(`legal_name = $${idx++}`); values.push(data.legalName || null) }
    if (data.cpfCnpj !== undefined) { setClauses.push(`cpf_cnpj = $${idx++}`); values.push(data.cpfCnpj || null) }
    if (data.ie !== undefined) { setClauses.push(`ie = $${idx++}`); values.push(data.ie || null) }
    if (data.email !== undefined) { setClauses.push(`email = $${idx++}`); values.push(data.email || null) }
    if (data.phone !== undefined) { setClauses.push(`phone = $${idx++}`); values.push(data.phone || null) }

    if (setClauses.length === 0) {
      response.status(400).json({ error: 'Nenhum campo para atualizar.' })
      return
    }

    setClauses.push('updated_at = now()')
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update customers set ${setClauses.join(', ')} where organization_id = $1 and id = $2 returning id`,
        values,
      ),
    )
    if ((result.rowCount ?? 0) === 0) {
      response.status(404).json({ error: 'Cliente não encontrado.' })
      return
    }
    response.json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.patch('/customers/:id/deactivate', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update customers set active = false, updated_at = now() where organization_id = $1 and id = $2 returning id`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) {
      response.status(404).json({ error: 'Cliente não encontrado.' })
      return
    }
    response.json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.put('/suppliers/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const data = supplierSchema.partial().parse(request.body)
    const setClauses: string[] = []
    const values: unknown[] = [organizationId, request.params.id]
    let idx = 3

    if (data.name !== undefined) { setClauses.push(`name = $${idx++}`); values.push(data.name) }
    if (data.personType !== undefined) { setClauses.push(`person_type = $${idx++}`); values.push(data.personType) }
    if (data.legalName !== undefined) { setClauses.push(`legal_name = $${idx++}`); values.push(data.legalName || null) }
    if (data.cpfCnpj !== undefined) { setClauses.push(`cpf_cnpj = $${idx++}`); values.push(data.cpfCnpj || null) }
    if (data.ie !== undefined) { setClauses.push(`ie = $${idx++}`); values.push(data.ie || null) }
    if (data.email !== undefined) { setClauses.push(`email = $${idx++}`); values.push(data.email || null) }
    if (data.phone !== undefined) { setClauses.push(`phone = $${idx++}`); values.push(data.phone || null) }

    if (setClauses.length === 0) {
      response.status(400).json({ error: 'Nenhum campo para atualizar.' })
      return
    }

    setClauses.push('updated_at = now()')
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update suppliers set ${setClauses.join(', ')} where organization_id = $1 and id = $2 returning id`,
        values,
      ),
    )
    if ((result.rowCount ?? 0) === 0) {
      response.status(404).json({ error: 'Fornecedor não encontrado.' })
      return
    }
    response.json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.patch('/suppliers/:id/deactivate', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update suppliers set active = false, updated_at = now() where organization_id = $1 and id = $2 returning id`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) {
      response.status(404).json({ error: 'Fornecedor não encontrado.' })
      return
    }
    response.json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.put('/products/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const data = productSchema.partial().parse(request.body)
    const setClauses: string[] = []
    const values: unknown[] = [organizationId, request.params.id]
    let idx = 3

    if (data.name !== undefined) { setClauses.push(`name = $${idx++}`); values.push(data.name) }
    if (data.sku !== undefined) { setClauses.push(`sku = $${idx++}`); values.push(data.sku || null) }
    if (data.description !== undefined) { setClauses.push(`description = $${idx++}`); values.push(data.description || null) }
    if (data.productType !== undefined) { setClauses.push(`product_type = $${idx++}`); values.push(data.productType) }
    if (data.ncm !== undefined) { setClauses.push(`ncm = $${idx++}`); values.push(data.ncm || null) }
    if (data.uom !== undefined) { setClauses.push(`uom = $${idx++}`); values.push(data.uom || null) }
    if (data.price !== undefined) { setClauses.push(`price = $${idx++}`); values.push(data.price) }
    if (data.cost !== undefined) { setClauses.push(`cost = $${idx++}`); values.push(data.cost) }

    if (setClauses.length === 0) {
      response.status(400).json({ error: 'Nenhum campo para atualizar.' })
      return
    }

    setClauses.push('updated_at = now()')
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update products set ${setClauses.join(', ')} where organization_id = $1 and id = $2 returning id`,
        values,
      ),
    )
    if ((result.rowCount ?? 0) === 0) {
      response.status(404).json({ error: 'Produto não encontrado.' })
      return
    }
    response.json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.patch('/products/:id/deactivate', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update products set active = false, updated_at = now() where organization_id = $1 and id = $2 returning id`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) {
      response.status(404).json({ error: 'Produto não encontrado.' })
      return
    }
    response.json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.put('/warehouses/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const data = warehouseSchema.partial().parse(request.body)
    const setClauses: string[] = []
    const values: unknown[] = [organizationId, request.params.id]
    let idx = 3

    if (data.name !== undefined) { setClauses.push(`name = $${idx++}`); values.push(data.name) }

    if (setClauses.length === 0) {
      response.status(400).json({ error: 'Nenhum campo para atualizar.' })
      return
    }

    setClauses.push('updated_at = now()')
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update warehouses set ${setClauses.join(', ')} where organization_id = $1 and id = $2 returning id`,
        values,
      ),
    )
    if ((result.rowCount ?? 0) === 0) {
      response.status(404).json({ error: 'Depósito não encontrado.' })
      return
    }
    response.json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/categories', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select id, name, parent_id as "parentId", created_at as "createdAt"
         from product_categories where organization_id = $1
         order by name asc`,
        [organizationId],
      )
      return rows.rows
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/categories', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ name: z.string().min(1), parentId: z.string().uuid().optional() })
    const data = schema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into product_categories (organization_id, name, parent_id) values ($1, $2, $3) returning id`,
        [organizationId, data.name, data.parentId ?? null],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/carriers', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select id, name, cnpj, modal, avg_days as "avgDays", active, created_at as "createdAt"
         from carriers where organization_id = $1
         order by name asc`,
        [organizationId],
      )
      return rows.rows
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/carriers', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      name: z.string().min(1),
      cnpj: z.string().optional(),
      modal: z.string().optional(),
      avgDays: z.number().int().nonnegative().optional(),
    })
    const data = schema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into carriers (organization_id, name, cnpj, modal, avg_days) values ($1, $2, $3, $4, $5) returning id`,
        [organizationId, data.name, data.cnpj ?? null, data.modal ?? null, data.avgDays ?? null],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/carriers/:id/toggle', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update carriers set active = not active where organization_id = $1 and id = $2 returning id, active`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Transportadora não encontrada.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

export { router as coreRoutes }
