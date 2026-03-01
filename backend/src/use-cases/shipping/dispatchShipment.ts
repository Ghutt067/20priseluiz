import type { PoolClient } from 'pg'

type DispatchShipmentInput = {
  organizationId: string
  shipmentId: string
}

export async function dispatchShipment(
  client: PoolClient,
  input: DispatchShipmentInput,
) {
  const result = await client.query(
    `update shipments
     set status = 'dispatched', dispatched_at = now()
     where organization_id = $1
       and id = $2`,
    [input.organizationId, input.shipmentId],
  )

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Expedição não encontrada para despacho.')
  }

  return { shipmentId: input.shipmentId }
}
