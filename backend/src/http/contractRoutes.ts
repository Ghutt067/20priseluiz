import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'

const router = Router()

const contractSchema = z.object({
  customerId: z.string().uuid().optional(),
  startDate: z.string().min(1),
  endDate: z.string().optional(),
  billingDay: z.number().int().min(1).max(31).optional(),
  items: z.array(z.object({
    description: z.string().min(1),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative(),
  })).min(1),
})

router.get('/contracts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const status = (request.query.status as string) ?? ''
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100)
    const offset = Math.max(Number(request.query.offset) || 0, 0)

    const result = await withOrgRead(organizationId, async (client) => {
      const conditions = ['c.organization_id = $1']
      const params: unknown[] = [organizationId]
      if (status && ['active', 'paused', 'cancelled'].includes(status)) {
        params.push(status)
        conditions.push(`c.status = $${params.length}`)
      }
      const where = conditions.join(' AND ')

      const countResult = await client.query(
        `SELECT count(*)::int AS total FROM contracts c WHERE ${where}`,
        params,
      )

      params.push(limit, offset)
      const rows = await client.query(
        `SELECT c.id, c.status, c.start_date AS "startDate", c.end_date AS "endDate",
                c.billing_day AS "billingDay", c.created_at AS "createdAt",
                cu.name AS "customerName",
                (SELECT coalesce(sum(ci.quantity * ci.unit_price), 0) FROM contract_items ci WHERE ci.contract_id = c.id AND ci.organization_id = c.organization_id) AS "totalAmount",
                (SELECT count(*)::int FROM contract_items ci WHERE ci.contract_id = c.id AND ci.organization_id = c.organization_id) AS "itemCount"
         FROM contracts c
         LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.organization_id = c.organization_id
         WHERE ${where}
         ORDER BY c.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )

      return { rows: rows.rows, total: countResult.rows[0]?.total ?? 0 }
    })

    response.setHeader('x-total-count', String(result.total))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/contracts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const data = contractSchema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      const contractResult = await client.query(
        `INSERT INTO contracts (organization_id, customer_id, start_date, end_date, billing_day, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING id`,
        [organizationId, data.customerId ?? null, data.startDate, data.endDate ?? null, data.billingDay ?? 1],
      )
      const contractId = contractResult.rows[0].id as string

      for (const item of data.items) {
        await client.query(
          `INSERT INTO contract_items (organization_id, contract_id, description, quantity, unit_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [organizationId, contractId, item.description, item.quantity, item.unitPrice],
        )
      }

      return { contractId }
    })

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.patch('/contracts/:id/status', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const { status } = z.object({ status: z.enum(['active', 'paused', 'cancelled']) }).parse(request.body)

    await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      await client.query(
        `UPDATE contracts SET status = $1 WHERE id = $2 AND organization_id = $3`,
        [status, request.params.id, organizationId],
      )
    })

    response.json({ id: request.params.id, status })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/contracts/:id', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)

    const result = await withOrgRead(organizationId, async (client) => {
      const contractResult = await client.query(
        `SELECT c.id, c.status, c.start_date AS "startDate", c.end_date AS "endDate",
                c.billing_day AS "billingDay", c.created_at AS "createdAt",
                cu.name AS "customerName", c.customer_id AS "customerId"
         FROM contracts c
         LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.organization_id = c.organization_id
         WHERE c.id = $1 AND c.organization_id = $2`,
        [request.params.id, organizationId],
      )
      if (contractResult.rows.length === 0) throw new Error('Contrato não encontrado.')

      const items = await client.query(
        `SELECT id, description, quantity, unit_price AS "unitPrice"
         FROM contract_items WHERE contract_id = $1 AND organization_id = $2
         ORDER BY id`,
        [request.params.id, organizationId],
      )

      return { ...contractResult.rows[0], items: items.rows }
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export const contractRoutes = router
