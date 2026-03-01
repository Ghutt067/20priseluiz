import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { recordAuditLog, runIdempotentMutation } from './mutationSafety'
import { increaseNullBatchStockLevel } from '../use-cases/core/stockLevelMutations'

const router = Router()

const STOCK_QTY_EPSILON = 0.0001

function roundStockQty(value: number) {
  if (!Number.isFinite(value)) return 0
  return Number(value.toFixed(4))
}

// getAuthUser and assertOrgMember imported from authMiddleware

router.get('/crm/appointments', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const from = (request.query.from as string) || null
    const to = (request.query.to as string) || null
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const conditions = ['a.organization_id = $1']
      const values: unknown[] = [organizationId]
      let idx = 2

      if (from) { conditions.push(`a.scheduled_at >= $${idx++}::timestamptz`); values.push(from) }
      if (to) { conditions.push(`a.scheduled_at <= $${idx++}::timestamptz`); values.push(to) }

      values.push(limit)
      const rows = await client.query(
        `select a.id, a.subject, a.scheduled_at as "scheduledAt", a.status, a.notes,
                coalesce(c.name, '') as "customerName"
         from appointments a
         left join customers c on c.id = a.customer_id
         where ${conditions.join(' and ')}
         order by a.scheduled_at desc
         limit $${idx}`,
        values,
      )
      return rows.rows
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/crm/calls', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select cl.id, cl.phone, cl.outcome, cl.notes, cl.occurred_at as "occurredAt",
                coalesce(c.name, '') as "customerName"
         from call_logs cl
         left join customers c on c.id = cl.customer_id
         where cl.organization_id = $1
         order by cl.occurred_at desc
         limit $2`,
        [organizationId, limit],
      )
      return rows.rows
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/crm/campaigns', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select id, name, channel, status, starts_at as "startsAt", ends_at as "endsAt", created_at as "createdAt"
         from marketing_campaigns
         where organization_id = $1
         order by created_at desc
         limit $2`,
        [organizationId, limit],
      )
      return rows.rows
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/crm/promotions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select pr.id, pr.name, pr.promo_price::numeric as "promoPrice", pr.status,
                pr.start_at as "startAt", pr.end_at as "endAt",
                coalesce(p.name, '') as "productName"
         from promotions pr
         left join products p on p.id = pr.product_id
         where pr.organization_id = $1
         order by pr.created_at desc
         limit $2`,
        [organizationId, limit],
      )
      return rows.rows.map((r: Record<string, unknown>) => ({ ...r, promoPrice: Number(r.promoPrice) }))
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/returns', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100)

    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select ro.id, ro.status, ro.reason, ro.created_at as "createdAt",
                coalesce(c.name, '') as "customerName",
                (select count(*)::int from return_items ri where ri.return_order_id = ro.id) as "itemCount"
         from return_orders ro
         left join customers c on c.id = ro.customer_id
         where ro.organization_id = $1
         order by ro.created_at desc
         limit $2`,
        [organizationId, limit],
      )
      return rows.rows
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/crm/appointments', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      customerId: z.string().uuid().optional(),
      subject: z.string().min(1),
      scheduledAt: z.string().min(1),
      notes: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into appointments
          (organization_id, customer_id, subject, scheduled_at, status, notes)
         values ($1, $2, $3, $4::timestamptz, 'scheduled', $5)
         returning id`,
        [
          organizationId,
          data.customerId ?? null,
          data.subject,
          data.scheduledAt,
          data.notes ?? null,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/crm/calls', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      customerId: z.string().uuid().optional(),
      phone: z.string().optional(),
      outcome: z.string().optional(),
      notes: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into call_logs
          (organization_id, customer_id, phone, outcome, notes)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [
          organizationId,
          data.customerId ?? null,
          data.phone ?? null,
          data.outcome ?? null,
          data.notes ?? null,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/crm/campaigns', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      name: z.string().min(1),
      channel: z.string().optional(),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into marketing_campaigns
          (organization_id, name, channel, status, starts_at, ends_at)
         values ($1, $2, $3, 'draft', $4::timestamptz, $5::timestamptz)
         returning id`,
        [
          organizationId,
          data.name,
          data.channel ?? null,
          data.startsAt ?? null,
          data.endsAt ?? null,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/crm/campaigns/:id/contacts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      customerId: z.string().uuid().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into campaign_contacts
          (organization_id, campaign_id, customer_id, email, phone)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [
          organizationId,
          request.params.id,
          data.customerId ?? null,
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

router.post('/crm/promotions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      productId: z.string().uuid().optional(),
      name: z.string().min(1),
      promoPrice: z.number().positive(),
      startAt: z.string().optional(),
      endAt: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'crm_promotion_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          if (data.productId) {
            const productResult = await client.query(
              `select 1
               from products
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.productId],
            )
            if ((productResult.rowCount ?? 0) === 0) {
              throw new Error('Produto da promoção não pertence à organização.')
            }
          }

          const result = await client.query(
            `insert into promotions
              (organization_id, product_id, name, promo_price, start_at, end_at, status)
             values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 'scheduled')
             returning id`,
            [
              organizationId,
              data.productId ?? null,
              data.name,
              data.promoPrice,
              data.startAt ?? null,
              data.endAt ?? null,
            ],
          )

          const promotionId = result.rows[0].id as string

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'promotions',
            recordId: promotionId,
            newData: {
              promotionId,
              productId: data.productId ?? null,
              name: data.name,
              promoPrice: data.promoPrice,
              startAt: data.startAt ?? null,
              endAt: data.endAt ?? null,
              status: 'scheduled',
            },
            metadata: {
              source: 'crm.promotion.create',
            },
          })

          return {
            status: 201,
            body: {
              id: promotionId,
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

router.post('/inventory/counts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      warehouseId: z.string().uuid(),
      items: z.array(
        z.object({
          product_id: z.string().uuid(),
          expected_qty: z.number().nonnegative(),
          counted_qty: z.number().nonnegative(),
        }),
      ).min(1, 'Inventário precisa ter ao menos um item.'),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'inventory_count_create_apply',
        idempotencyKey,
        requestBody: data,
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

          const productIds = Array.from(new Set(data.items.map((item) => item.product_id)))
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

          const countInsertResult = await client.query(
            `insert into inventory_counts
              (organization_id, warehouse_id, status, counted_at)
             values ($1, $2, 'counted', now())
             returning id`,
            [organizationId, data.warehouseId],
          )

          const countId = countInsertResult.rows[0].id as string
          let adjustedItems = 0

          for (const item of data.items) {
            await client.query(
              `insert into inventory_count_items
                (organization_id, count_id, product_id, expected_qty, counted_qty)
               values ($1, $2, $3, $4, $5)`,
              [
                organizationId,
                countId,
                item.product_id,
                roundStockQty(item.expected_qty),
                roundStockQty(item.counted_qty),
              ],
            )

            const stockRowsResult = await client.query(
              `select id,
                      qty_available::numeric as qty_available,
                      qty_reserved::numeric as qty_reserved
               from stock_levels
               where organization_id = $1
                 and warehouse_id = $2
                 and product_id = $3
               order by qty_available desc, updated_at desc
               for update`,
              [organizationId, data.warehouseId, item.product_id],
            )

            const stockRows = stockRowsResult.rows as Array<{
              id: string
              qty_available: string | number
              qty_reserved: string | number
            }>

            const currentAvailable = roundStockQty(
              stockRows.reduce((sum, row) => sum + Number(row.qty_available ?? 0), 0),
            )
            const currentReserved = roundStockQty(
              stockRows.reduce((sum, row) => sum + Number(row.qty_reserved ?? 0), 0),
            )
            const countedQty = roundStockQty(item.counted_qty)

            if (countedQty + STOCK_QTY_EPSILON < currentReserved) {
              throw new Error(
                `Inventário não pode baixar abaixo do reservado. Produto ${item.product_id.slice(0, 8)}: reservado ${currentReserved.toFixed(4)} | contado ${countedQty.toFixed(4)}.`,
              )
            }

            const diff = roundStockQty(countedQty - currentAvailable)
            if (Math.abs(diff) <= STOCK_QTY_EPSILON) {
              continue
            }

            if (diff > 0) {
              await increaseNullBatchStockLevel({
                client,
                organizationId,
                productId: item.product_id,
                warehouseId: data.warehouseId,
                quantity: diff,
              })
            } else {
              let remainingToReduce = roundStockQty(-diff)

              for (const row of stockRows) {
                if (remainingToReduce <= STOCK_QTY_EPSILON) {
                  break
                }

                const rowAvailable = roundStockQty(Number(row.qty_available ?? 0))
                if (rowAvailable <= STOCK_QTY_EPSILON) {
                  continue
                }

                const deduction = roundStockQty(Math.min(rowAvailable, remainingToReduce))
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

                remainingToReduce = roundStockQty(remainingToReduce - deduction)
              }

              if (remainingToReduce > STOCK_QTY_EPSILON) {
                throw new Error(
                  `Falha ao aplicar ajuste de inventário. Produto ${item.product_id.slice(0, 8)} sem saldo disponível suficiente para reduzir.`,
                )
              }
            }

            adjustedItems += 1

            await client.query(
              `insert into stock_movements
                (organization_id, product_id, warehouse_id, movement_type, quantity, reason, ref_table, ref_id)
               values ($1, $2, $3, 'adjust', $4, $5, 'inventory_counts', $6)`,
              [
                organizationId,
                item.product_id,
                data.warehouseId,
                diff,
                `Ajuste de inventário (esperado ${item.expected_qty} | contado ${item.counted_qty})`,
                countId,
              ],
            )
          }

          await client.query(
            `update inventory_counts
             set status = 'adjusted'
             where organization_id = $1
               and id = $2`,
            [organizationId, countId],
          )

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'inventory_counts',
            recordId: countId,
            newData: {
              countId,
              warehouseId: data.warehouseId,
              itemsCount: data.items.length,
              adjustedItems,
            },
            metadata: {
              source: 'crm.inventory.count.apply',
            },
          })

          return {
            status: 201,
            body: {
              countId,
              adjustedItems,
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

router.post('/returns', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      customerId: z.string().uuid().optional(),
      reason: z.string().optional(),
      items: z.array(
        z.object({
          product_id: z.string().uuid().optional(),
          quantity: z.number().positive(),
          condition: z.string().optional(),
        }),
      ).min(1, 'Devolução precisa ter ao menos um item.'),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'return_order_create',
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
              throw new Error('Cliente da devolução não pertence à organização.')
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
              throw new Error('Produto da devolução não pertence à organização.')
            }
          }

          const orderResult = await client.query(
            `insert into return_orders
              (organization_id, customer_id, status, reason)
             values ($1, $2, 'requested', $3)
             returning id`,
            [organizationId, data.customerId ?? null, data.reason ?? null],
          )

          const returnOrderId = orderResult.rows[0].id as string
          for (const item of data.items) {
            await client.query(
              `insert into return_items
                (organization_id, return_order_id, product_id, quantity, condition)
               values ($1, $2, $3, $4, $5)`,
              [
                organizationId,
                returnOrderId,
                item.product_id ?? null,
                item.quantity,
                item.condition ?? null,
              ],
            )
          }

          const totalQuantity = data.items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0)
          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'return_orders',
            recordId: returnOrderId,
            newData: {
              returnOrderId,
              customerId: data.customerId ?? null,
              reason: data.reason ?? null,
              itemsCount: data.items.length,
              totalQuantity: Number(totalQuantity.toFixed(4)),
            },
            metadata: {
              source: 'crm.return.create',
            },
          })

          return {
            status: 201,
            body: { returnOrderId },
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

router.patch('/crm/appointments/:id/status', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ status: z.enum(['completed', 'cancelled']) })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update appointments set status = $1 where organization_id = $2 and id = $3 returning id`,
        [data.status, organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Agendamento não encontrado.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/crm/campaigns/:id/status', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ status: z.enum(['active', 'completed']) })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update marketing_campaigns set status = $1 where organization_id = $2 and id = $3 returning id`,
        [data.status, organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Campanha não encontrada.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/crm/campaigns/:id/contacts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select cc.id, cc.email, cc.phone, cc.created_at as "createdAt",
                coalesce(c.name, '') as "customerName"
         from campaign_contacts cc
         left join customers c on c.id = cc.customer_id
         where cc.organization_id = $1 and cc.campaign_id = $2
         order by cc.created_at desc`,
        [organizationId, request.params.id],
      )
      return rows.rows
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/crm/promotions/:id/status', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ status: z.enum(['active', 'ended']) })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update promotions set status = $1 where organization_id = $2 and id = $3 returning id`,
        [data.status, organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Promoção não encontrada.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/returns/:id/status', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({ status: z.enum(['approved', 'received', 'refunded']) })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update return_orders set status = $1 where organization_id = $2 and id = $3 returning id`,
        [data.status, organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Devolução não encontrada.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/crm/pipeline', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select cp.id, cp.name, cp.stage, cp.estimated_value::numeric as "estimatedValue",
                cp.notes, cp.created_at as "createdAt", cp.updated_at as "updatedAt",
                coalesce(c.name, '') as "customerName"
         from crm_pipeline cp
         left join customers c on c.id = cp.customer_id
         where cp.organization_id = $1
         order by cp.updated_at desc`,
        [organizationId],
      )
      return rows.rows.map((r: Record<string, unknown>) => ({
        ...r,
        estimatedValue: r.estimatedValue ? Number(r.estimatedValue) : null,
      }))
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/crm/pipeline', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      name: z.string().min(1),
      customerId: z.string().uuid().optional(),
      estimatedValue: z.number().nonnegative().optional(),
      notes: z.string().optional(),
    })
    const data = schema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into crm_pipeline (organization_id, customer_id, name, estimated_value, notes)
         values ($1, $2, $3, $4, $5) returning id`,
        [organizationId, data.customerId ?? null, data.name, data.estimatedValue ?? null, data.notes ?? null],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/crm/pipeline/:id/stage', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      stage: z.enum(['contact', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost']),
    })
    const data = schema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update crm_pipeline set stage = $1, updated_at = now()
         where organization_id = $2 and id = $3 returning id`,
        [data.stage, organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Oportunidade não encontrada.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/crm/customers/:customerId/history', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const { customerId } = request.params

    const result = await withOrgRead(organizationId, async (client) => {
      const [orders, appointments, calls, returns] = await Promise.all([
        client.query(
          `select id, total_amount::numeric as amount, status, created_at as "createdAt", 'sale' as type
           from sales_orders where organization_id = $1 and customer_id = $2 order by created_at desc limit 10`,
          [organizationId, customerId],
        ),
        client.query(
          `select id, subject, scheduled_at as "createdAt", status, 'appointment' as type
           from appointments where organization_id = $1 and customer_id = $2 order by scheduled_at desc limit 5`,
          [organizationId, customerId],
        ),
        client.query(
          `select id, outcome as subject, occurred_at as "createdAt", 'call' as type
           from call_logs where organization_id = $1 and customer_id = $2 order by occurred_at desc limit 5`,
          [organizationId, customerId],
        ),
        client.query(
          `select id, reason as subject, created_at as "createdAt", status, 'return' as type
           from return_orders where organization_id = $1 and customer_id = $2 order by created_at desc limit 5`,
          [organizationId, customerId],
        ),
      ])

      const items = [
        ...orders.rows.map((r: Record<string, unknown>) => ({ ...r, amount: Number(r.amount) })),
        ...appointments.rows,
        ...calls.rows,
        ...returns.rows,
      ]

      items.sort((a, b) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime())
      return items.slice(0, 20)
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/coupons', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select id, code, coupon_type as "couponType", value::numeric as value,
                max_uses as "maxUses", uses_count as "usesCount", valid_until as "validUntil", active, created_at as "createdAt"
         from coupons where organization_id = $1 order by created_at desc`,
        [organizationId],
      )
      return rows.rows.map((r: Record<string, unknown>) => ({ ...r, value: Number(r.value) }))
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/coupons', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      code: z.string().min(1),
      couponType: z.enum(['percent', 'fixed']),
      value: z.number().positive(),
      maxUses: z.number().int().positive().optional(),
      validUntil: z.string().optional(),
    })
    const data = schema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into coupons (organization_id, code, coupon_type, value, max_uses, valid_until)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [organizationId, data.code.toUpperCase(), data.couponType, data.value, data.maxUses ?? null, data.validUntil ? `${data.validUntil}::timestamptz` : null],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.patch('/coupons/:id/toggle', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update coupons set active = not active where organization_id = $1 and id = $2 returning id, active`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Cupom não encontrado.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

export { router as crmRoutes }
