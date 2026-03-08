import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { assignTechnician } from '../use-cases/service/assignTechnician'
import { createServiceOrder } from '../use-cases/service/createServiceOrder'
import { invoiceServiceOrder } from '../use-cases/service/invoiceServiceOrder'
import { logServiceTime } from '../use-cases/service/logServiceTime'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { recordAuditLog, runIdempotentMutation } from './mutationSafety'

const router = Router()

const SERVICE_ORDER_STATUS_VALUES = ['open', 'in_progress', 'completed', 'cancelled'] as const
const SERVICE_TIME_ENTRY_TYPE_VALUES = ['labor', 'diagnostic'] as const

function normalizeOptionalQueryValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function parseOptionalBooleanQueryFlag(value: unknown): boolean | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  throw new Error('Valor booleano inválido para o filtro informado.')
}

function parseLimitOffset(
  query: Record<string, unknown>,
  defaults?: {
    limit?: number
    maxLimit?: number
  },
) {
  const parsedLimit = Number.parseInt(typeof query.limit === 'string' ? query.limit : '', 10)
  const parsedOffset = Number.parseInt(typeof query.offset === 'string' ? query.offset : '', 10)
  const maxLimit = Math.max(defaults?.maxLimit ?? 200, 1)
  const fallbackLimit = Math.min(Math.max(defaults?.limit ?? 30, 1), maxLimit)
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), maxLimit)
    : fallbackLimit
  const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0
  return { limit, offset }
}

function isAllowedValue<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return (allowed as readonly string[]).includes(value)
}

function setReplayHeaderIfNeeded(
  response: { setHeader: (name: string, value: string) => void },
  replayed: boolean,
) {
  if (replayed) {
    response.setHeader('x-idempotent-replay', 'true')
  }
}

// getAuthUser and assertOrgMember imported from authMiddleware

function canTransitionServiceOrderStatus(
  currentStatus: (typeof SERVICE_ORDER_STATUS_VALUES)[number],
  nextStatus: (typeof SERVICE_ORDER_STATUS_VALUES)[number],
) {
  if (currentStatus === nextStatus) {
    return true
  }

  if (currentStatus === 'open') {
    return nextStatus === 'in_progress' || nextStatus === 'completed' || nextStatus === 'cancelled'
  }

  if (currentStatus === 'in_progress') {
    return nextStatus === 'completed' || nextStatus === 'cancelled'
  }

  return false
}

router.get('/services/orders', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const status = normalizeOptionalQueryValue(request.query.status)
    const query = normalizeOptionalQueryValue(request.query.query)
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 30,
      maxLimit: 200,
    })

    if (status && !isAllowedValue(status, SERVICE_ORDER_STATUS_VALUES)) {
      throw new Error('Status inválido.')
    }

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from service_orders so
         left join customers c
           on c.id = so.customer_id
          and c.organization_id = so.organization_id
         left join vehicles v
           on v.id = so.vehicle_id
          and v.organization_id = so.organization_id
         where so.organization_id = $1
           and ($2 = '' or so.status::text = $2)
           and (
             $3 = ''
             or so.id::text = $3
             or smart_search_match(lower(unaccent(coalesce(c.name, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.plate, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.brand, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.model, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(so.notes, ''))), $3, $4)
           )`,
        [organizationId, status, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           so.id,
           so.status,
           so.total_amount as "totalAmount",
           so.notes,
           so.scheduled_at as "scheduledAt",
           so.created_at as "createdAt",
           so.updated_at as "updatedAt",
           so.customer_id as "customerId",
           c.name as "customerName",
           so.vehicle_id as "vehicleId",
           v.plate as "vehiclePlate",
           v.brand as "vehicleBrand",
           v.model as "vehicleModel",
           billing."invoiceId",
           billing."fiscalDocumentId",
           billing."receivableTitleId",
           billing."invoicedAt"
         from service_orders so
         left join customers c
           on c.id = so.customer_id
          and c.organization_id = so.organization_id
         left join vehicles v
           on v.id = so.vehicle_id
          and v.organization_id = so.organization_id
         left join lateral (
           select
             ft.invoice_id as "invoiceId",
             fd.id as "fiscalDocumentId",
             ft.id as "receivableTitleId",
             i.issued_at as "invoicedAt"
           from financial_titles ft
           join invoices i
             on i.id = ft.invoice_id
            and i.organization_id = ft.organization_id
           left join fiscal_documents fd
             on fd.organization_id = ft.organization_id
            and fd.invoice_id = ft.invoice_id
           where ft.organization_id = so.organization_id
             and ft.title_type = 'receivable'
             and ft.description = 'Faturamento da OS ' || so.id::text
             and ft.invoice_id is not null
           order by ft.created_at desc, fd.created_at desc
           limit 1
         ) billing on true
         where so.organization_id = $1
           and ($2 = '' or so.status::text = $2)
           and (
             $3 = ''
             or so.id::text = $3
             or smart_search_match(lower(unaccent(coalesce(c.name, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.plate, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.brand, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.model, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(so.notes, ''))), $3, $4)
           )
         order by so.updated_at desc
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

router.get('/services/orders/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const serviceOrderId = request.params.id

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const orderResult = await client.query(
        `select
           so.id,
           so.status,
           so.total_amount as "totalAmount",
           so.notes,
           so.scheduled_at as "scheduledAt",
           so.created_at as "createdAt",
           so.updated_at as "updatedAt",
           so.customer_id as "customerId",
           c.name as "customerName",
           so.vehicle_id as "vehicleId",
           v.plate as "vehiclePlate",
           v.brand as "vehicleBrand",
           v.model as "vehicleModel",
           v.year as "vehicleYear",
           v.color as "vehicleColor",
           v.vin as "vehicleVin",
           billing."invoiceId",
           billing."fiscalDocumentId",
           billing."receivableTitleId",
           billing."invoicedAt"
         from service_orders so
         left join customers c
           on c.id = so.customer_id
          and c.organization_id = so.organization_id
         left join vehicles v
           on v.id = so.vehicle_id
          and v.organization_id = so.organization_id
         left join lateral (
           select
             ft.invoice_id as "invoiceId",
             fd.id as "fiscalDocumentId",
             ft.id as "receivableTitleId",
             i.issued_at as "invoicedAt"
           from financial_titles ft
           join invoices i
             on i.id = ft.invoice_id
            and i.organization_id = ft.organization_id
           left join fiscal_documents fd
             on fd.organization_id = ft.organization_id
            and fd.invoice_id = ft.invoice_id
           where ft.organization_id = so.organization_id
             and ft.title_type = 'receivable'
             and ft.description = 'Faturamento da OS ' || so.id::text
             and ft.invoice_id is not null
           order by ft.created_at desc, fd.created_at desc
           limit 1
         ) billing on true
         where so.organization_id = $1
           and so.id = $2
         limit 1`,
        [organizationId, serviceOrderId],
      )

      if ((orderResult.rowCount ?? 0) === 0) {
        throw new Error('Ordem de serviço não encontrada.')
      }

      const itemsResult = await client.query(
        `select
           soi.id,
           soi.product_id as "productId",
           p.name as "productName",
           p.sku as "productSku",
           soi.description,
           soi.quantity,
           soi.unit_price as "unitPrice",
           soi.total_price as "totalPrice",
           soi.hours_worked as "hoursWorked"
         from service_order_items soi
         left join products p
           on p.id = soi.product_id
          and p.organization_id = soi.organization_id
         where soi.organization_id = $1
           and soi.service_order_id = $2
         order by soi.id asc`,
        [organizationId, serviceOrderId],
      )

      const checklistResult = await client.query(
        `select
           sc.id,
           sc.item,
           sc.is_done as "isDone"
         from service_checklists sc
         where sc.organization_id = $1
           and sc.service_order_id = $2
         order by sc.id asc`,
        [organizationId, serviceOrderId],
      )

      const techniciansResult = await client.query(
        `select
           sot.id,
           sot.technician_id as "technicianId",
           t.name as "technicianName",
           sot.hours_worked as "hoursWorked"
         from service_order_technicians sot
         join technicians t
           on t.id = sot.technician_id
          and t.organization_id = sot.organization_id
         where sot.organization_id = $1
           and sot.service_order_id = $2
         order by t.name asc`,
        [organizationId, serviceOrderId],
      )

      return {
        order: orderResult.rows[0],
        items: itemsResult.rows,
        checklist: checklistResult.rows,
        technicians: techniciansResult.rows,
      }
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/services/vehicles', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const query = normalizeOptionalQueryValue(request.query.query)
    const customerId = normalizeOptionalQueryValue(request.query.customerId)
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 30,
      maxLimit: 200,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from vehicles v
         left join customers c
           on c.id = v.customer_id
          and c.organization_id = v.organization_id
         where v.organization_id = $1
           and ($2 = '' or coalesce(v.customer_id::text, '') = $2)
           and (
             $3 = ''
             or v.id::text = $3
             or smart_search_match(lower(unaccent(coalesce(v.plate, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.brand, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.model, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.vin, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(c.name, ''))), $3, $4)
           )`,
        [organizationId, customerId, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           v.id,
           v.customer_id as "customerId",
           c.name as "customerName",
           v.plate,
           v.brand,
           v.model,
           v.year,
           v.color,
           v.vin,
           v.created_at as "createdAt",
           v.updated_at as "updatedAt"
         from vehicles v
         left join customers c
           on c.id = v.customer_id
          and c.organization_id = v.organization_id
         where v.organization_id = $1
           and ($2 = '' or coalesce(v.customer_id::text, '') = $2)
           and (
             $3 = ''
             or v.id::text = $3
             or smart_search_match(lower(unaccent(coalesce(v.plate, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.brand, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.model, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(v.vin, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(c.name, ''))), $3, $4)
           )
         order by v.updated_at desc
         limit $5
         offset $6`,
        [organizationId, customerId, query, likeQuery, limit, offset],
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

router.get('/services/technicians', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const query = normalizeOptionalQueryValue(request.query.query)
    const active = parseOptionalBooleanQueryFlag(request.query.active)
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 30,
      maxLimit: 200,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from technicians t
         where t.organization_id = $1
           and ($2::boolean is null or t.active = $2)
           and (
             $3 = ''
             or t.id::text = $3
             or smart_search_match(lower(unaccent(coalesce(t.name, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(t.email, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(t.phone, ''))), $3, $4)
           )`,
        [organizationId, active, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           t.id,
           t.name,
           t.email,
           t.phone,
           t.active,
           t.created_at as "createdAt"
         from technicians t
         where t.organization_id = $1
           and ($2::boolean is null or t.active = $2)
           and (
             $3 = ''
             or t.id::text = $3
             or smart_search_match(lower(unaccent(coalesce(t.name, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(t.email, ''))), $3, $4)
             or smart_search_match(lower(unaccent(coalesce(t.phone, ''))), $3, $4)
           )
         order by t.active desc, t.name asc
         limit $5
         offset $6`,
        [organizationId, active, query, likeQuery, limit, offset],
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

router.post('/services/orders', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      customerId: z.uuid().optional(),
      vehicleId: z.uuid().optional(),
      scheduledAt: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(
        z.object({
          product_id: z.uuid().optional(),
          description: z.string().min(1),
          quantity: z.number().positive(),
          unit_price: z.number().nonnegative(),
          hours_worked: z.number().optional(),
        }),
      ).min(1, 'Ordem de serviço precisa ter ao menos um item.'),
      checklist: z
        .array(
          z.object({
            item: z.string().min(1),
          }),
        )
        .optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'service_order_create',
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

          if (data.vehicleId) {
            const vehicleResult = await client.query<{ customer_id: string | null }>(
              `select customer_id
               from vehicles
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.vehicleId],
            )

            if ((vehicleResult.rowCount ?? 0) === 0) {
              throw new Error('Veículo informado não pertence à organização.')
            }

            const vehicleCustomerId = vehicleResult.rows[0]?.customer_id ?? null
            if (data.customerId && vehicleCustomerId && vehicleCustomerId !== data.customerId) {
              throw new Error('Veículo informado pertence a outro cliente.')
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
              throw new Error('Há itens da OS com produto inválido para esta organização.')
            }
          }

          const result = await createServiceOrder(client, {
            organizationId,
            customerId: data.customerId ?? null,
            vehicleId: data.vehicleId ?? null,
            scheduledAt: data.scheduledAt ?? null,
            notes: data.notes ?? null,
            items: data.items,
            checklist: data.checklist,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'service_orders',
            recordId: result.serviceOrderId,
            newData: {
              serviceOrderId: result.serviceOrderId,
              customerId: data.customerId ?? null,
              vehicleId: data.vehicleId ?? null,
              status: 'open',
              totalAmount: result.totalAmount,
              scheduledAt: data.scheduledAt ?? null,
              itemsCount: data.items.length,
              checklistCount: data.checklist?.length ?? 0,
            },
            metadata: {
              source: 'services.order.create',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/services/orders/:id/status', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const serviceOrderId = z.uuid().parse(request.params.id)
    const schema = z.object({
      status: z.enum(SERVICE_ORDER_STATUS_VALUES),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'service_order_update_status',
        idempotencyKey,
        requestBody: {
          serviceOrderId,
          ...data,
        },
        execute: async () => {
          const statusResult = await client.query<{ status: string }>(
            `select status::text as status
             from service_orders
             where organization_id = $1
               and id = $2
             limit 1
             for update`,
            [organizationId, serviceOrderId],
          )

          if ((statusResult.rowCount ?? 0) === 0) {
            throw new Error('Ordem de serviço não encontrada para a organização informada.')
          }

          const currentStatusRaw = String(statusResult.rows[0]?.status ?? '')
          if (!isAllowedValue(currentStatusRaw, SERVICE_ORDER_STATUS_VALUES)) {
            throw new Error('Status atual da OS é inválido.')
          }

          if (!canTransitionServiceOrderStatus(currentStatusRaw, data.status)) {
            throw new Error(
              `Transição de status inválida: ${currentStatusRaw} -> ${data.status}.`,
            )
          }

          if (currentStatusRaw !== data.status) {
            await client.query(
              `update service_orders
               set status = $3
               where organization_id = $1
                 and id = $2`,
              [organizationId, serviceOrderId, data.status],
            )
          }

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'service_orders',
            recordId: serviceOrderId,
            oldData: {
              status: currentStatusRaw,
            },
            newData: {
              status: data.status,
            },
            metadata: {
              source: 'services.order.update-status',
            },
          })

          return {
            status: 200,
            body: {
              serviceOrderId,
              status: data.status,
            },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/services/orders/:id/invoice', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const serviceOrderId = z.uuid().parse(request.params.id)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'service_order_invoice',
        idempotencyKey,
        requestBody: {
          serviceOrderId,
        },
        execute: async () => {
          const result = await invoiceServiceOrder(client, {
            organizationId,
            serviceOrderId,
          })

          if (!result.reused || result.previousStatus !== result.status) {
            await recordAuditLog({
              client,
              organizationId,
              actorUserId: user.id,
              operation: 'update',
              tableName: 'service_orders',
              recordId: serviceOrderId,
              oldData: {
                status: result.previousStatus,
                invoiceId: result.previousInvoiceId,
                fiscalDocumentId: result.previousFiscalDocumentId,
                receivableTitleId: result.previousReceivableTitleId,
                invoicedAt: result.previousInvoicedAt,
              },
              newData: {
                status: result.status,
                invoiceId: result.invoiceId,
                fiscalDocumentId: result.fiscalDocumentId,
                receivableTitleId: result.receivableTitleId,
                invoicedAt: result.invoicedAt,
              },
              metadata: {
                source: 'services.order.invoice',
              },
            })
          }

          return {
            status: result.reused ? 200 : 201,
            body: {
              serviceOrderId: result.serviceOrderId,
              status: result.status,
              invoiceId: result.invoiceId,
              fiscalDocumentId: result.fiscalDocumentId,
              receivableTitleId: result.receivableTitleId,
              invoicedAt: result.invoicedAt,
              reused: result.reused,
            },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/services/orders/:id/technicians', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const serviceOrderId = z.uuid().parse(request.params.id)
    const schema = z.object({
      technicianId: z.uuid(),
      hoursWorked: z.number().nonnegative().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'service_order_assign_technician',
        idempotencyKey,
        requestBody: {
          serviceOrderId,
          ...data,
        },
        execute: async () => {
          const orderResult = await client.query(
            `select 1
             from service_orders
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, serviceOrderId],
          )

          if ((orderResult.rowCount ?? 0) === 0) {
            throw new Error('Ordem de serviço não encontrada para a organização informada.')
          }

          const technicianResult = await client.query<{ active: boolean }>(
            `select active
             from technicians
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, data.technicianId],
          )

          if ((technicianResult.rowCount ?? 0) === 0) {
            throw new Error('Técnico informado não pertence à organização.')
          }

          if ((technicianResult.rows[0]?.active ?? true) === false) {
            throw new Error('Técnico informado está inativo.')
          }

          const result = await assignTechnician(client, {
            organizationId,
            serviceOrderId,
            technicianId: data.technicianId,
            hoursWorked: data.hoursWorked ?? 0,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'service_orders',
            recordId: serviceOrderId,
            newData: {
              assignedTechnicianId: data.technicianId,
              hoursWorked: data.hoursWorked ?? 0,
            },
            metadata: {
              source: 'services.order.assign-technician',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/services/orders/:id/time', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const serviceOrderId = z.uuid().parse(request.params.id)
    const schema = z.object({
      technicianId: z.uuid().optional(),
      entryType: z.enum(SERVICE_TIME_ENTRY_TYPE_VALUES).optional(),
      hours: z.number().positive(),
      notes: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'service_order_log_time',
        idempotencyKey,
        requestBody: {
          serviceOrderId,
          ...data,
        },
        execute: async () => {
          const orderResult = await client.query(
            `select 1
             from service_orders
             where organization_id = $1
               and id = $2
             limit 1`,
            [organizationId, serviceOrderId],
          )

          if ((orderResult.rowCount ?? 0) === 0) {
            throw new Error('Ordem de serviço não encontrada para a organização informada.')
          }

          if (data.technicianId) {
            const technicianResult = await client.query<{ active: boolean }>(
              `select active
               from technicians
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.technicianId],
            )

            if ((technicianResult.rowCount ?? 0) === 0) {
              throw new Error('Técnico informado não pertence à organização.')
            }

            if ((technicianResult.rows[0]?.active ?? true) === false) {
              throw new Error('Técnico informado está inativo.')
            }
          }

          const result = await logServiceTime(client, {
            organizationId,
            serviceOrderId,
            technicianId: data.technicianId ?? null,
            entryType: data.entryType ?? 'labor',
            hours: data.hours,
            notes: data.notes ?? null,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'service_time_entries',
            recordId: result.timeEntryId,
            newData: {
              timeEntryId: result.timeEntryId,
              serviceOrderId,
              technicianId: data.technicianId ?? null,
              entryType: data.entryType ?? 'labor',
              hours: data.hours,
            },
            metadata: {
              source: 'services.order.log-time',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/services/vehicles', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      customerId: z.uuid().optional(),
      plate: z.string().optional(),
      brand: z.string().optional(),
      model: z.string().optional(),
      year: z.number().int().optional(),
      color: z.string().optional(),
      vin: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'service_vehicle_create',
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

          const result = await client.query(
            `insert into vehicles
              (organization_id, customer_id, plate, brand, model, year, color, vin)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             returning id`,
            [
              organizationId,
              data.customerId ?? null,
              data.plate ?? null,
              data.brand ?? null,
              data.model ?? null,
              data.year ?? null,
              data.color ?? null,
              data.vin ?? null,
            ],
          )

          const vehicleId = result.rows[0].id as string

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'vehicles',
            recordId: vehicleId,
            newData: {
              vehicleId,
              customerId: data.customerId ?? null,
              plate: data.plate ?? null,
              brand: data.brand ?? null,
              model: data.model ?? null,
              year: data.year ?? null,
              color: data.color ?? null,
              vin: data.vin ?? null,
            },
            metadata: {
              source: 'services.vehicle.create',
            },
          })

          return {
            status: 201,
            body: {
              id: vehicleId,
            },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/services/technicians', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().optional(),
      phone: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'service_technician_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const result = await client.query(
            `insert into technicians (organization_id, name, email, phone, active)
             values ($1, $2, $3, $4, true)
             returning id`,
            [organizationId, data.name, data.email ?? null, data.phone ?? null],
          )

          const technicianId = result.rows[0].id as string

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'technicians',
            recordId: technicianId,
            newData: {
              technicianId,
              name: data.name,
              email: data.email ?? null,
              phone: data.phone ?? null,
              active: true,
            },
            metadata: {
              source: 'services.technician.create',
            },
          })

          return {
            status: 201,
            body: {
              id: technicianId,
            },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export { router as serviceRoutes }
