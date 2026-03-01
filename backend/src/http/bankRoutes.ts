import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { registerPayment } from '../use-cases/finance/registerPayment'

const router = Router()

router.get('/bank/integrations', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select id, provider, name, active, created_at as "createdAt"
         from bank_integrations where organization_id = $1
         order by created_at desc limit 20`,
        [organizationId],
      )
      return rows.rows
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/bank/integrations', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      provider: z.enum(['pix', 'boleto', 'bank_api']),
      name: z.string().optional(),
      config: z.unknown().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into bank_integrations
          (organization_id, provider, name, config, active)
         values ($1, $2, $3, $4, true)
         returning id`,
        [organizationId, data.provider, data.name ?? null, data.config ?? null],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/bank/webhooks', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      integrationId: z.string().uuid().optional(),
      eventType: z.string().min(1),
      payload: z.unknown(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into bank_webhook_events
          (organization_id, integration_id, event_type, payload, status)
         values ($1, $2, $3, $4, 'received')
         returning id`,
        [
          organizationId,
          data.integrationId ?? null,
          data.eventType,
          data.payload,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/bank/webhooks/process-payment', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      installmentId: z.string().uuid(),
      accountId: z.string().uuid().optional(),
      amount: z.number().positive(),
      method: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      registerPayment(client, {
        organizationId,
        installmentId: data.installmentId,
        accountId: data.accountId ?? null,
        amount: data.amount,
        method: data.method ?? 'pix',
      }),
    )

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.patch('/bank/integrations/:id/toggle', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update bank_integrations set active = not active
         where organization_id = $1 and id = $2 returning id, active`,
        [organizationId, request.params.id],
      ),
    )
    if ((result.rowCount ?? 0) === 0) throw new Error('Integração não encontrada.')
    response.json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/bank/webhooks', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select bwe.id, bwe.event_type as "eventType", bwe.status, bwe.created_at as "createdAt",
                coalesce(bi.name, bi.provider::text, '') as "integrationName"
         from bank_webhook_events bwe
         left join bank_integrations bi on bi.id = bwe.integration_id
         where bwe.organization_id = $1
         order by bwe.created_at desc limit $2`,
        [organizationId, limit],
      )
      return rows.rows
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.get('/finance/accounts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select id, name, type, balance::numeric as balance, created_at as "createdAt"
         from financial_accounts where organization_id = $1
         order by created_at desc`,
        [organizationId],
      )
      return rows.rows.map((r: Record<string, unknown>) => ({ ...r, balance: Number(r.balance) }))
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/finance/accounts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      name: z.string().min(1),
      type: z.enum(['bank', 'cash', 'card']).optional(),
    })
    const data = schema.parse(request.body)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into financial_accounts (organization_id, name, type, balance)
         values ($1, $2, $3, 0) returning id`,
        [organizationId, data.name, data.type ?? 'bank'],
      ),
    )
    response.status(201).json(result.rows[0])
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

export { router as bankRoutes }
