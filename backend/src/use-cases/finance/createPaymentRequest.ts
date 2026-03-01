import type { PoolClient } from 'pg'

type CreatePaymentRequestInput = {
  organizationId: string
  titleId?: string | null
  provider: 'pix' | 'boleto' | 'bank_api'
  amount: number
  payload?: Record<string, unknown> | null
}

export async function createPaymentRequest(
  client: PoolClient,
  input: CreatePaymentRequestInput,
) {
  const result = await client.query(
    `insert into payment_requests
      (organization_id, title_id, provider, amount, status, payload)
     values ($1, $2, $3, $4, 'created', $5)
     returning id`,
    [
      input.organizationId,
      input.titleId ?? null,
      input.provider,
      input.amount,
      input.payload ?? null,
    ],
  )

  return { paymentRequestId: result.rows[0].id as string }
}
