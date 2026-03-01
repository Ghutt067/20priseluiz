import type { PoolClient } from 'pg'

type DeliverShipmentInput = {
  organizationId: string
  shipmentId: string
}

export async function deliverShipment(client: PoolClient, input: DeliverShipmentInput) {
  const result = await client.query(
    `update shipments
     set status = 'delivered', delivered_at = now()
     where organization_id = $1
       and id = $2`,
    [input.organizationId, input.shipmentId],
  )

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Expedição não encontrada para concluir retirada.')
  }

  return { shipmentId: input.shipmentId }
}
