import type { PoolClient } from 'pg'

type CreateFinancialTitleInput = {
  organizationId: string
  titleType: 'receivable' | 'payable'
  customerId?: string | null
  supplierId?: string | null
  description?: string | null
  totalAmount: number
  installmentCount?: number
  firstDueDate: string
}

export async function createFinancialTitle(
  client: PoolClient,
  input: CreateFinancialTitleInput,
) {
  const normalizedInstallmentCount = Math.max(1, Math.floor(input.installmentCount ?? 1))
  const totalInCents = Math.round(input.totalAmount * 100)
  const baseInstallmentCents = Math.floor(totalInCents / normalizedInstallmentCount)
  const remainderCents = totalInCents - baseInstallmentCents * normalizedInstallmentCount

  const result = await client.query(
    `insert into financial_titles
      (organization_id, title_type, customer_id, supplier_id, description, total_amount, status)
     values ($1, $2, $3, $4, $5, $6, 'open')
     returning id`,
    [
      input.organizationId,
      input.titleType,
      input.customerId ?? null,
      input.supplierId ?? null,
      input.description ?? null,
      input.totalAmount,
    ],
  )

  const titleId = result.rows[0].id as string

  for (let index = 0; index < normalizedInstallmentCount; index += 1) {
    const installmentAmountCents =
      baseInstallmentCents + (index < remainderCents ? 1 : 0)
    const installmentAmount = Number((installmentAmountCents / 100).toFixed(2))

    await client.query(
      `insert into financial_installments
        (organization_id, title_id, due_date, amount, status)
       values ($1, $2, ($3::date + ($4 || ' month')::interval)::date, $5, 'open')`,
      [
        input.organizationId,
        titleId,
        input.firstDueDate,
        index,
        installmentAmount,
      ],
    )
  }

  return { titleId }
}
