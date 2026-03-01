import type { PoolClient } from 'pg'

type LogServiceTimeInput = {
  organizationId: string
  serviceOrderId: string
  technicianId?: string | null
  entryType?: 'labor' | 'diagnostic'
  hours: number
  notes?: string | null
}

export async function logServiceTime(client: PoolClient, input: LogServiceTimeInput) {
  const result = await client.query(
    `insert into service_time_entries
      (organization_id, service_order_id, technician_id, entry_type, hours, notes)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      input.organizationId,
      input.serviceOrderId,
      input.technicianId ?? null,
      input.entryType ?? 'labor',
      input.hours,
      input.notes ?? null,
    ],
  )

  return { timeEntryId: result.rows[0].id as string }
}
