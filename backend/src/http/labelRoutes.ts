import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { recordAuditLog, runIdempotentMutation } from './mutationSafety'

const router = Router()

// getAuthUser and assertOrgMember imported from authMiddleware

function normalizeOptionalQueryValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

router.get('/labels', async (request, response) => {
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
         from labels l
         left join products p
           on p.id = l.product_id
          and p.organization_id = l.organization_id
         where l.organization_id = $1
           and ($2 = '' or l.status::text = $2)
           and (
             $3 = ''
             or l.id::text = $3
             or coalesce(p.name, '') ilike $4
             or coalesce(p.sku, '') ilike $4
           )`,
        [organizationId, status, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           l.id,
           l.product_id as "productId",
           p.name as "productName",
           p.sku as "productSku",
           l.quantity,
           l.status,
           l.payload,
           l.created_at as "createdAt"
         from labels l
         left join products p
           on p.id = l.product_id
          and p.organization_id = l.organization_id
         where l.organization_id = $1
           and ($2 = '' or l.status::text = $2)
           and (
             $3 = ''
             or l.id::text = $3
             or coalesce(p.name, '') ilike $4
             or coalesce(p.sku, '') ilike $4
           )
         order by l.created_at desc
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

router.post('/labels', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      productId: z.uuid().optional(),
      quantity: z.number().int().positive(),
      payload: z.unknown().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'label_create',
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
              throw new Error('Produto da etiqueta não pertence à organização.')
            }
          }

          const result = await client.query(
            `insert into labels
              (organization_id, product_id, quantity, payload, status)
             values ($1, $2, $3, $4, 'pending')
             returning id`,
            [
              organizationId,
              data.productId ?? null,
              data.quantity,
              data.payload ?? null,
            ],
          )

          const labelId = result.rows[0].id as string
          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'labels',
            recordId: labelId,
            newData: {
              labelId,
              productId: data.productId ?? null,
              quantity: data.quantity,
              status: 'pending',
            },
            metadata: {
              source: 'labels.create',
            },
          })

          return {
            status: 201,
            body: { id: labelId },
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

router.post('/labels/:id/mark-printed', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const labelId = z.uuid().parse(request.params.id)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'label_mark_printed',
        idempotencyKey,
        requestBody: { labelId },
        execute: async () => {
          const labelResult = await client.query<{ status: string }>(
            `select status::text as status
             from labels
             where organization_id = $1
               and id = $2
             limit 1
             for update`,
            [organizationId, labelId],
          )

          if ((labelResult.rowCount ?? 0) === 0) {
            throw new Error('Etiqueta não encontrada para a organização informada.')
          }

          const currentStatus = String(labelResult.rows[0].status ?? 'pending')
          if (currentStatus !== 'printed') {
            await client.query(
              `update labels
               set status = 'printed'
               where organization_id = $1
                 and id = $2`,
              [organizationId, labelId],
            )
          }

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'labels',
            recordId: labelId,
            newData: {
              labelId,
              previousStatus: currentStatus,
              status: 'printed',
            },
            metadata: {
              source: 'labels.markPrinted',
            },
          })

          return {
            status: 201,
            body: {
              id: labelId,
              status: 'printed',
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

export { router as labelRoutes }
