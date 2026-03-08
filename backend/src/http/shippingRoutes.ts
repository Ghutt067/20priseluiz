import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { createShipment } from '../use-cases/shipping/createShipment'
import { dispatchShipment } from '../use-cases/shipping/dispatchShipment'
import { deliverShipment } from '../use-cases/shipping/deliverShipment'
import { recordAuditLog, runIdempotentMutation } from './mutationSafety'

const router = Router()

// getAuthUser and assertOrgMember imported from authMiddleware

function normalizeOptionalQueryValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

router.get('/shipping/shipments', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const status = normalizeOptionalQueryValue(request.query.status)
    const query = normalizeOptionalQueryValue(request.query.query)
    const likeQuery = `%${query}%`
    const parsedLimit = Number.parseInt(
      typeof request.query.limit === 'string' ? request.query.limit : '30',
      10,
    )
    const parsedOffset = Number.parseInt(
      typeof request.query.offset === 'string' ? request.query.offset : '0',
      10,
    )
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 30
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(parsedOffset, 0)
      : 0

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from shipments s
         left join customers c
           on c.id = s.customer_id
          and c.organization_id = s.organization_id
         where s.organization_id = $1
           and ($2 = '' or s.status::text = $2)
           and (
             $3 = ''
             or s.id::text = $3
             or coalesce(s.sales_order_id::text, '') = $3
             or smart_search_match(lower(unaccent(coalesce(c.name, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(s.carrier, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(s.tracking_code, ''))), $3, $4)
           )`,
        [organizationId, status, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           s.id,
           s.sales_order_id as "salesOrderId",
           s.customer_id as "customerId",
           c.name as "customerName",
           s.type,
           s.status,
           s.carrier,
           s.tracking_code as "trackingCode",
           s.dispatched_at as "dispatchedAt",
           s.delivered_at as "deliveredAt",
           s.created_at as "createdAt",
           coalesce(count(si.id), 0)::int as "itemsCount",
           coalesce(sum(si.quantity), 0)::numeric as "totalQuantity"
         from shipments s
         left join customers c
           on c.id = s.customer_id
          and c.organization_id = s.organization_id
         left join shipment_items si
           on si.shipment_id = s.id
          and si.organization_id = s.organization_id
         where s.organization_id = $1
           and ($2 = '' or s.status::text = $2)
           and (
             $3 = ''
             or s.id::text = $3
             or coalesce(s.sales_order_id::text, '') = $3
             or smart_search_match(lower(unaccent(coalesce(c.name, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(s.carrier, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(s.tracking_code, ''))), $3, $4)
           )
         group by
           s.id,
           s.sales_order_id,
           s.customer_id,
           c.name,
           s.type,
           s.status,
           s.carrier,
           s.tracking_code,
           s.dispatched_at,
           s.delivered_at,
           s.created_at
         order by s.created_at desc
         limit $5
         offset $6`,
        [organizationId, status, query, likeQuery, limit, offset],
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

router.post('/shipping/shipments', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      salesOrderId: z.uuid().optional(),
      customerId: z.uuid().optional(),
      type: z.enum(['delivery', 'pickup']).optional(),
      carrier: z.string().optional(),
      trackingCode: z.string().optional(),
      items: z.array(
        z.object({
          product_id: z.uuid().optional(),
          quantity: z.number().positive(),
        }),
      ).min(1, 'Expedição precisa ter ao menos um item.'),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'shipment_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const result = await createShipment(client, {
            organizationId,
            salesOrderId: data.salesOrderId ?? null,
            customerId: data.customerId ?? null,
            type: data.type ?? 'delivery',
            carrier: data.carrier ?? null,
            trackingCode: data.trackingCode ?? null,
            items: data.items,
          })

          const totalQuantity = data.items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0)
          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'shipments',
            recordId: result.shipmentId,
            newData: {
              shipmentId: result.shipmentId,
              salesOrderId: data.salesOrderId ?? null,
              customerId: data.customerId ?? null,
              type: data.type ?? 'delivery',
              carrier: data.carrier ?? null,
              trackingCode: data.trackingCode ?? null,
              status: 'pending',
              itemsCount: data.items.length,
              totalQuantity: Number(totalQuantity.toFixed(4)),
            },
            metadata: {
              source: 'shipping.shipment.create',
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

router.post('/shipping/shipments/:id/dispatch', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const shipmentId = z.uuid().parse(request.params.id)
    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'shipment_dispatch',
        idempotencyKey,
        requestBody: { shipmentId },
        execute: async () => {
          const result = await dispatchShipment(client, {
            organizationId,
            shipmentId,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'shipments',
            recordId: shipmentId,
            newData: {
              shipmentId,
              status: 'dispatched',
            },
            metadata: {
              source: 'shipping.shipment.dispatch',
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

router.post('/shipping/shipments/:id/deliver', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const shipmentId = z.uuid().parse(request.params.id)
    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'shipment_deliver',
        idempotencyKey,
        requestBody: { shipmentId },
        execute: async () => {
          const result = await deliverShipment(client, {
            organizationId,
            shipmentId,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'shipments',
            recordId: shipmentId,
            newData: {
              shipmentId,
              status: 'delivered',
            },
            metadata: {
              source: 'shipping.shipment.deliver',
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

export { router as shippingRoutes }
