import type { PoolClient } from 'pg'

type AssignTechnicianInput = {
  organizationId: string
  serviceOrderId: string
  technicianId: string
  hoursWorked?: number
}

export async function assignTechnician(
  client: PoolClient,
  input: AssignTechnicianInput,
) {
  await client.query(
    `insert into service_order_technicians
      (organization_id, service_order_id, technician_id, hours_worked)
     values ($1, $2, $3, $4)`,
    [
      input.organizationId,
      input.serviceOrderId,
      input.technicianId,
      input.hoursWorked ?? 0,
    ],
  )

  return { serviceOrderId: input.serviceOrderId }
}
