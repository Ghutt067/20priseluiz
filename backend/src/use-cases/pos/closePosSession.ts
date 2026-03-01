import type { PoolClient } from 'pg'

type ClosePosSessionInput = {
  organizationId: string
  sessionId: string
}

export async function closePosSession(client: PoolClient, input: ClosePosSessionInput) {
  await client.query(
    `update pos_sessions
     set status = 'closed', closed_at = now()
     where id = $1`,
    [input.sessionId],
  )

  return { sessionId: input.sessionId }
}
