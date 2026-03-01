import type { PoolClient } from 'pg'

type OpenPosSessionInput = {
  organizationId: string
  cashierId?: string | null
}

export async function openPosSession(client: PoolClient, input: OpenPosSessionInput) {
  const result = await client.query(
    `insert into pos_sessions
      (organization_id, cashier_id, status, opened_at)
     values ($1, $2, 'open', now())
     returning id`,
    [input.organizationId, input.cashierId ?? null],
  )

  return { sessionId: result.rows[0].id as string }
}
