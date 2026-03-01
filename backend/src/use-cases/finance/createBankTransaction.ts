import type { PoolClient } from 'pg'

type CreateBankTransactionInput = {
  organizationId: string
  accountId?: string | null
  direction: 'in' | 'out'
  amount: number
  description?: string | null
  externalRef?: string | null
  occurredAt?: string | null
}

export async function createBankTransaction(
  client: PoolClient,
  input: CreateBankTransactionInput,
) {
  const result = await client.query(
    `insert into bank_transactions
      (organization_id, account_id, direction, amount, description, external_ref, occurred_at, status)
     values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), 'pending')
     returning id`,
    [
      input.organizationId,
      input.accountId ?? null,
      input.direction,
      input.amount,
      input.description ?? null,
      input.externalRef ?? null,
      input.occurredAt ?? null,
    ],
  )

  return { bankTransactionId: result.rows[0].id as string }
}
