import type { PoolClient } from 'pg'

const PAYMENT_METHODS = ['cash', 'card', 'pix', 'boleto', 'transfer', 'other'] as const
type PaymentMethod = (typeof PAYMENT_METHODS)[number]

type RegisterPaymentInput = {
  organizationId: string
  installmentId: string
  accountId?: string | null
  amount: number
  method?: string | null
  paidAt?: string | null
}

function normalizePaymentMethod(method?: string | null): PaymentMethod {
  if (!method) return 'other'
  const normalized = method.trim().toLowerCase()
  if ((PAYMENT_METHODS as readonly string[]).includes(normalized)) {
    return normalized as PaymentMethod
  }
  throw new Error('Método de pagamento inválido.')
}

export async function registerPayment(client: PoolClient, input: RegisterPaymentInput) {
  const normalizedAmount = Number(input.amount.toFixed(2))
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error('Valor do pagamento inválido.')
  }

  const paymentMethod = normalizePaymentMethod(input.method)

  const installmentResult = await client.query(
    `select fi.id,
            fi.title_id,
            fi.amount::numeric as amount,
            fi.status::text as installment_status,
            ft.title_type::text as title_type
     from financial_installments fi
     join financial_titles ft
       on ft.organization_id = fi.organization_id
      and ft.id = fi.title_id
     where fi.organization_id = $1
       and fi.id = $2
     limit 1
     for update`,
    [input.organizationId, input.installmentId],
  )

  if (installmentResult.rowCount === 0) {
    throw new Error('Parcela nao encontrada.')
  }

  const installment = installmentResult.rows[0] as {
    id: string
    title_id: string
    amount: string | number
    installment_status: string
    title_type: 'receivable' | 'payable'
  }

  if (installment.installment_status === 'paid') {
    throw new Error('Parcela já está paga.')
  }

  if (installment.installment_status === 'canceled') {
    throw new Error('Parcela cancelada não pode ser paga.')
  }

  const installmentAmount = Number(installment.amount ?? 0)
  if (Math.abs(installmentAmount - normalizedAmount) > 0.01) {
    throw new Error('Pagamento parcial ainda não é suportado. Informe o valor exato da parcela.')
  }

  if (input.accountId) {
    const accountResult = await client.query(
      `select 1
       from financial_accounts
       where organization_id = $1
         and id = $2
       limit 1`,
      [input.organizationId, input.accountId],
    )
    if ((accountResult.rowCount ?? 0) === 0) {
      throw new Error('Conta financeira inválida para a organização informada.')
    }
  }

  const signedAmount =
    installment.title_type === 'payable'
      ? -Math.abs(normalizedAmount)
      : Math.abs(normalizedAmount)
  const flowDescription =
    installment.title_type === 'payable' ? 'Pagamento registrado' : 'Recebimento registrado'

  await client.query(
    `update financial_installments
     set paid_at = coalesce($1::timestamptz, now()),
         status = 'paid'
     where organization_id = $2
       and id = $3`,
    [input.paidAt ?? null, input.organizationId, input.installmentId],
  )

  await client.query(
    `insert into cash_flow_entries
      (organization_id, account_id, title_id, entry_date, amount, description)
     values ($1, $2, $3, coalesce($4::date, current_date), $5, $6)`,
    [
      input.organizationId,
      input.accountId ?? null,
      installment.title_id,
      input.paidAt ?? null,
      signedAmount,
      flowDescription,
    ],
  )

  const paymentResult = await client.query(
    `insert into payment_transactions
      (organization_id, title_id, method, amount, status)
     values ($1, $2, $3, $4, 'processed')`,
    [
      input.organizationId,
      installment.title_id,
      paymentMethod,
      normalizedAmount,
    ],
  )

  const titleStatusResult = await client.query<{ open_count: number }>(
    `select count(*)::int as open_count
     from financial_installments
     where organization_id = $1
       and title_id = $2
       and status <> 'paid'`,
    [input.organizationId, installment.title_id],
  )

  const openCount = Number(titleStatusResult.rows[0]?.open_count ?? 0)
  const titleStatus = openCount === 0 ? 'paid' : 'open'

  await client.query(
    `update financial_titles
     set status = $1::financial_status
     where organization_id = $2
       and id = $3`,
    [titleStatus, input.organizationId, installment.title_id],
  )

  return {
    installmentId: input.installmentId,
    titleId: installment.title_id,
    titleStatus,
    signedAmount,
    paymentMethod,
    paymentTransactionCount: Number(paymentResult.rowCount ?? 0),
  }
}
