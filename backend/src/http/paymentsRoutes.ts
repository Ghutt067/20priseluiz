import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'

const router = Router()

router.post('/payments/cheques', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      titleId: z.string().uuid().optional(),
      bank: z.string().optional(),
      agency: z.string().optional(),
      account: z.string().optional(),
      chequeNumber: z.string().optional(),
      dueDate: z.string().optional(),
      amount: z.number().positive(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into cheque_payments
          (organization_id, title_id, bank, agency, account, cheque_number, due_date, amount, status)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8, 'pending')
         returning id`,
        [
          organizationId,
          data.titleId ?? null,
          data.bank ?? null,
          data.agency ?? null,
          data.account ?? null,
          data.chequeNumber ?? null,
          data.dueDate ?? null,
          data.amount,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/payments/cards', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      titleId: z.string().uuid().optional(),
      brand: z.string().optional(),
      holderName: z.string().optional(),
      last4: z.string().optional(),
      installments: z.number().int().positive().optional(),
      amount: z.number().positive(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into card_payments
          (organization_id, title_id, brand, holder_name, last4, installments, amount, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'authorized')
         returning id`,
        [
          organizationId,
          data.titleId ?? null,
          data.brand ?? null,
          data.holderName ?? null,
          data.last4 ?? null,
          data.installments ?? 1,
          data.amount,
        ],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export { router as paymentsRoutes }
