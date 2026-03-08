import { createHash } from 'node:crypto'
import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { createBankTransaction } from '../use-cases/finance/createBankTransaction'
import { createFinancialTitle } from '../use-cases/finance/createFinancialTitle'
import { createPaymentRequest } from '../use-cases/finance/createPaymentRequest'
import { importOfx } from '../use-cases/finance/importOfx'
import { registerPayment } from '../use-cases/finance/registerPayment'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { recordAuditLog, runIdempotentMutation } from './mutationSafety'

const router = Router()

const PAYMENT_METHOD_VALUES = ['cash', 'card', 'pix', 'boleto', 'transfer', 'other'] as const
const FINANCIAL_STATUS_VALUES = ['open', 'paid', 'canceled', 'overdue'] as const
const TITLE_TYPE_VALUES = ['receivable', 'payable'] as const
const BANK_STATUS_VALUES = ['pending', 'cleared', 'reconciled'] as const
const RECONCILIATION_ADJUSTMENT_TYPES = ['bank_fee', 'interest', 'pix_fee', 'reversal', 'other'] as const
const RECONCILIATION_ACTIVITY_SOURCES = [
  'finance.reconcile.settle',
  'finance.reconcile.adjustment',
  'finance.reconcile.manual',
  'finance.ofx.import',
] as const

function normalizeOptionalQueryValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function hasAdvancedReconcilePermission(role: string) {
  const normalized = role.trim().toLowerCase()
  return normalized === 'chefe' || normalized === 'admin'
}

function isPgErrorWithCode(error: unknown, code: string) {
  if (typeof error !== 'object' || error === null) return false
  return 'code' in error && (error as { code?: string }).code === code
}

function parseLimitOffset(
  query: Record<string, unknown>,
  defaults?: {
    limit?: number
    maxLimit?: number
  },
) {
  const parsedLimit = Number.parseInt(typeof query.limit === 'string' ? query.limit : '', 10)
  const parsedOffset = Number.parseInt(typeof query.offset === 'string' ? query.offset : '', 10)
  const maxLimit = Math.max(defaults?.maxLimit ?? 200, 1)
  const fallbackLimit = Math.min(Math.max(defaults?.limit ?? 30, 1), maxLimit)
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), maxLimit)
    : fallbackLimit
  const offset = Number.isFinite(parsedOffset)
    ? Math.max(parsedOffset, 0)
    : 0
  return { limit, offset }
}

function isAllowedValue<T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return (allowed as readonly string[]).includes(value)
}

function setReplayHeaderIfNeeded(response: { setHeader: (name: string, value: string) => void }, replayed: boolean) {
  if (replayed) {
    response.setHeader('x-idempotent-replay', 'true')
  }
}

function hashText(raw: string) {
  return createHash('sha256').update(raw).digest('hex')
}

function adjustmentTypeLabel(value: (typeof RECONCILIATION_ADJUSTMENT_TYPES)[number]) {
  if (value === 'bank_fee') return 'Tarifa bancaria'
  if (value === 'interest') return 'Juros'
  if (value === 'pix_fee') return 'Tarifa PIX'
  if (value === 'reversal') return 'Estorno'
  return 'Outro'
}

// getAuthUser and assertOrgMember imported from authMiddleware

router.get('/finance/accounts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const query = normalizeOptionalQueryValue(request.query.query)
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 50,
      maxLimit: 200,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from financial_accounts fa
         where fa.organization_id = $1
           and (
             $2 = ''
             or smart_search_match(lower(unaccent(fa.name)), $2, $3)
             or smart_search_match(lower(unaccent(coalesce(fa.bank_code, ''))), $2, $3)
             or smart_search_match(lower(unaccent(coalesce(fa.agency, ''))), $2, $3)
             or smart_search_match(lower(unaccent(coalesce(fa.account_number, ''))), $2, $3)
           )`,
        [organizationId, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           fa.id,
           fa.name,
           fa.bank_code as "bankCode",
           fa.agency,
           fa.account_number as "accountNumber",
           fa.active,
           fa.created_at as "createdAt"
         from financial_accounts fa
         where fa.organization_id = $1
           and (
             $2 = ''
             or smart_search_match(lower(unaccent(fa.name)), $2, $3)
             or smart_search_match(lower(unaccent(coalesce(fa.bank_code, ''))), $2, $3)
             or smart_search_match(lower(unaccent(coalesce(fa.agency, ''))), $2, $3)
             or smart_search_match(lower(unaccent(coalesce(fa.account_number, ''))), $2, $3)
           )
         order by greatest(
           smart_search_score(lower(unaccent(fa.name)), $2, $3),
           smart_search_score(lower(unaccent(coalesce(fa.bank_code, ''))), $2, $3)
         ) desc, fa.created_at desc
         limit $4
         offset $5`,
        [organizationId, query, likeQuery, limit, offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/accounts', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      name: z.string().min(1),
      bankCode: z.string().optional(),
      agency: z.string().optional(),
      accountNumber: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_account_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const result = await client.query<{ id: string }>(
            `insert into financial_accounts
              (organization_id, name, bank_code, agency, account_number, active)
             values ($1, $2, $3, $4, $5, true)
             returning id`,
            [
              organizationId,
              data.name,
              data.bankCode ?? null,
              data.agency ?? null,
              data.accountNumber ?? null,
            ],
          )

          const accountId = result.rows[0].id

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'financial_accounts',
            recordId: accountId,
            newData: {
              accountId,
              name: data.name,
              bankCode: data.bankCode ?? null,
              agency: data.agency ?? null,
              accountNumber: data.accountNumber ?? null,
              active: true,
            },
            metadata: {
              source: 'finance.account.create',
            },
          })

          return {
            status: 201,
            body: { id: accountId },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/finance/titles', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const titleTypeRaw = normalizeOptionalQueryValue(request.query.titleType)
    const statusRaw = normalizeOptionalQueryValue(request.query.status)
    const query = normalizeOptionalQueryValue(request.query.query)
    const titleType = isAllowedValue(titleTypeRaw, TITLE_TYPE_VALUES) ? titleTypeRaw : ''
    const status = isAllowedValue(statusRaw, FINANCIAL_STATUS_VALUES) ? statusRaw : ''
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 30,
      maxLimit: 200,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from financial_titles ft
         left join customers c
           on c.id = ft.customer_id
          and c.organization_id = ft.organization_id
         left join suppliers s
           on s.id = ft.supplier_id
          and s.organization_id = ft.organization_id
         where ft.organization_id = $1
           and ($2 = '' or ft.title_type::text = $2)
           and ($3 = '' or ft.status::text = $3)
           and (
             $4 = ''
             or smart_search_match(lower(unaccent(coalesce(ft.description, ''))), $4, $5)
             or smart_search_match(coalesce(c.name_search, lower(unaccent(coalesce(c.name, '')))), $4, $5)
             or smart_search_match(coalesce(s.name_search, lower(unaccent(coalesce(s.name, '')))), $4, $5)
           )`,
        [organizationId, titleType, status, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           ft.id,
           ft.title_type as "titleType",
           ft.status,
           ft.description,
           ft.total_amount as "totalAmount",
           ft.created_at as "createdAt",
           ft.customer_id as "customerId",
           c.name as "customerName",
           ft.supplier_id as "supplierId",
           s.name as "supplierName",
           coalesce(sum(fi.amount) filter (where fi.status = 'paid'), 0)::numeric as "paidAmount",
           coalesce(sum(fi.amount) filter (where fi.status <> 'paid'), 0)::numeric as "openAmount",
           min(fi.due_date) filter (where fi.status = 'open') as "nextDueDate",
           max(fi.due_date) as "lastDueDate",
           count(fi.id)::int as "installmentsCount"
         from financial_titles ft
         left join customers c
           on c.id = ft.customer_id
          and c.organization_id = ft.organization_id
         left join suppliers s
           on s.id = ft.supplier_id
          and s.organization_id = ft.organization_id
         left join financial_installments fi
           on fi.title_id = ft.id
          and fi.organization_id = ft.organization_id
         where ft.organization_id = $1
           and ($2 = '' or ft.title_type::text = $2)
           and ($3 = '' or ft.status::text = $3)
           and (
             $4 = ''
             or smart_search_match(lower(unaccent(coalesce(ft.description, ''))), $4, $5)
             or smart_search_match(coalesce(c.name_search, lower(unaccent(coalesce(c.name, '')))), $4, $5)
             or smart_search_match(coalesce(s.name_search, lower(unaccent(coalesce(s.name, '')))), $4, $5)
           )
         group by ft.id, c.name, s.name
         order by greatest(
           smart_search_score(lower(unaccent(coalesce(ft.description, ''))), $4, $5),
           smart_search_score(coalesce(c.name_search, lower(unaccent(coalesce(c.name, '')))), $4, $5),
           smart_search_score(coalesce(s.name_search, lower(unaccent(coalesce(s.name, '')))), $4, $5)
         ) desc, ft.created_at desc
         limit $6
         offset $7`,
        [organizationId, titleType, status, query, likeQuery, limit, offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/titles', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      titleType: z.enum(TITLE_TYPE_VALUES),
      customerId: z.uuid().optional(),
      supplierId: z.uuid().optional(),
      description: z.string().optional(),
      totalAmount: z.number().positive(),
      installmentCount: z.number().int().positive().optional(),
      firstDueDate: z.string().min(1),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_title_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          if (data.titleType === 'receivable' && !data.customerId) {
            throw new Error('Título a receber exige cliente.')
          }
          if (data.titleType === 'payable' && !data.supplierId) {
            throw new Error('Título a pagar exige fornecedor.')
          }

          if (data.customerId) {
            const customerResult = await client.query(
              `select 1
               from customers
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.customerId],
            )
            if ((customerResult.rowCount ?? 0) === 0) {
              throw new Error('Cliente do título não pertence à organização.')
            }
          }

          if (data.supplierId) {
            const supplierResult = await client.query(
              `select 1
               from suppliers
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.supplierId],
            )
            if ((supplierResult.rowCount ?? 0) === 0) {
              throw new Error('Fornecedor do título não pertence à organização.')
            }
          }

          const result = await createFinancialTitle(client, {
            organizationId,
            titleType: data.titleType,
            customerId: data.customerId ?? null,
            supplierId: data.supplierId ?? null,
            description: data.description ?? null,
            totalAmount: data.totalAmount,
            installmentCount: data.installmentCount ?? 1,
            firstDueDate: data.firstDueDate,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'financial_titles',
            recordId: result.titleId,
            newData: {
              titleId: result.titleId,
              titleType: data.titleType,
              customerId: data.customerId ?? null,
              supplierId: data.supplierId ?? null,
              description: data.description ?? null,
              totalAmount: data.totalAmount,
              installmentCount: data.installmentCount ?? 1,
              firstDueDate: data.firstDueDate,
            },
            metadata: {
              source: 'finance.title.create',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/finance/titles/:id/installments', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const titleId = z.uuid().parse(request.params.id)

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return client.query(
        `select fi.id,
                fi.due_date,
                fi.amount,
                fi.paid_at,
                fi.status,
                ft.title_type as title_type
         from financial_installments fi
         join financial_titles ft
           on ft.organization_id = fi.organization_id
          and ft.id = fi.title_id
         where fi.organization_id = $1
           and fi.title_id = $2
         order by fi.due_date asc`,
        [organizationId, titleId],
      )
    })

    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/finance/installments', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const statusRaw = normalizeOptionalQueryValue(request.query.status)
    const titleTypeRaw = normalizeOptionalQueryValue(request.query.titleType)
    const customerId = normalizeOptionalQueryValue(request.query.customerId)
    const supplierId = normalizeOptionalQueryValue(request.query.supplierId)
    const dueFrom = normalizeOptionalQueryValue(request.query.dueFrom)
    const dueTo = normalizeOptionalQueryValue(request.query.dueTo)
    const query = normalizeOptionalQueryValue(request.query.query)
    const status = isAllowedValue(statusRaw, FINANCIAL_STATUS_VALUES) ? statusRaw : ''
    const titleType = isAllowedValue(titleTypeRaw, TITLE_TYPE_VALUES) ? titleTypeRaw : ''
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 50,
      maxLimit: 200,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from financial_installments fi
         join financial_titles ft
           on ft.organization_id = fi.organization_id
          and ft.id = fi.title_id
         left join customers c
           on c.id = ft.customer_id
          and c.organization_id = ft.organization_id
         left join suppliers s
           on s.id = ft.supplier_id
          and s.organization_id = ft.organization_id
         where fi.organization_id = $1
           and ($2 = '' or fi.status::text = $2)
           and ($3 = '' or ft.title_type::text = $3)
           and ($4 = '' or ft.customer_id::text = $4)
           and ($5 = '' or ft.supplier_id::text = $5)
           and ($6 = '' or fi.due_date >= $6::date)
           and ($7 = '' or fi.due_date <= $7::date)
           and (
             $8 = ''
             or smart_search_match(lower(unaccent(coalesce(ft.description, ''))), $8, $9)
             or smart_search_match(coalesce(c.name_search, lower(unaccent(coalesce(c.name, '')))), $8, $9)
             or smart_search_match(coalesce(s.name_search, lower(unaccent(coalesce(s.name, '')))), $8, $9)
           )`,
        [organizationId, status, titleType, customerId, supplierId, dueFrom, dueTo, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           fi.id,
           fi.title_id as "titleId",
           fi.due_date as "dueDate",
           fi.amount,
           fi.paid_at as "paidAt",
           fi.status,
           ft.title_type as "titleType",
           ft.description as "titleDescription",
           ft.customer_id as "customerId",
           c.name as "customerName",
           ft.supplier_id as "supplierId",
           s.name as "supplierName"
         from financial_installments fi
         join financial_titles ft
           on ft.organization_id = fi.organization_id
          and ft.id = fi.title_id
         left join customers c
           on c.id = ft.customer_id
          and c.organization_id = ft.organization_id
         left join suppliers s
           on s.id = ft.supplier_id
          and s.organization_id = ft.organization_id
         where fi.organization_id = $1
           and ($2 = '' or fi.status::text = $2)
           and ($3 = '' or ft.title_type::text = $3)
           and ($4 = '' or ft.customer_id::text = $4)
           and ($5 = '' or ft.supplier_id::text = $5)
           and ($6 = '' or fi.due_date >= $6::date)
           and ($7 = '' or fi.due_date <= $7::date)
           and (
             $8 = ''
             or smart_search_match(lower(unaccent(coalesce(ft.description, ''))), $8, $9)
             or smart_search_match(coalesce(c.name_search, lower(unaccent(coalesce(c.name, '')))), $8, $9)
             or smart_search_match(coalesce(s.name_search, lower(unaccent(coalesce(s.name, '')))), $8, $9)
           )
         order by fi.due_date asc, fi.id asc
         limit $10
         offset $11`,
        [
          organizationId,
          status,
          titleType,
          customerId,
          supplierId,
          dueFrom,
          dueTo,
          query,
          likeQuery,
          limit,
          offset,
        ],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/finance/inbox/today', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const parsedLimit = Number.parseInt(
      typeof request.query.limit === 'string' ? request.query.limit : '',
      10,
    )
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 20

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const dueTodayResult = await client.query(
        `select
           fi.id,
           fi.title_id as "titleId",
           fi.due_date as "dueDate",
           fi.amount,
           fi.paid_at as "paidAt",
           fi.status,
           ft.title_type as "titleType",
           ft.description as "titleDescription",
           ft.customer_id as "customerId",
           c.name as "customerName",
           ft.supplier_id as "supplierId",
           s.name as "supplierName"
         from financial_installments fi
         join financial_titles ft
           on ft.organization_id = fi.organization_id
          and ft.id = fi.title_id
         left join customers c
           on c.id = ft.customer_id
          and c.organization_id = ft.organization_id
         left join suppliers s
           on s.id = ft.supplier_id
          and s.organization_id = ft.organization_id
         where fi.organization_id = $1
           and fi.status = 'open'
           and fi.due_date = current_date
         order by fi.due_date asc, fi.id asc
         limit $2`,
        [organizationId, limit],
      )

      const overdueResult = await client.query(
        `select
           fi.id,
           fi.title_id as "titleId",
           fi.due_date as "dueDate",
           fi.amount,
           fi.paid_at as "paidAt",
           fi.status,
           ft.title_type as "titleType",
           ft.description as "titleDescription",
           ft.customer_id as "customerId",
           c.name as "customerName",
           ft.supplier_id as "supplierId",
           s.name as "supplierName"
         from financial_installments fi
         join financial_titles ft
           on ft.organization_id = fi.organization_id
          and ft.id = fi.title_id
         left join customers c
           on c.id = ft.customer_id
          and c.organization_id = ft.organization_id
         left join suppliers s
           on s.id = ft.supplier_id
          and s.organization_id = ft.organization_id
         where fi.organization_id = $1
           and fi.status = 'open'
           and fi.due_date < current_date
         order by fi.due_date asc, fi.id asc
         limit $2`,
        [organizationId, limit],
      )

      const pendingTransactionsResult = await client.query(
        `select
           bt.id,
           bt.account_id as "accountId",
           fa.name as "accountName",
           bt.direction,
           bt.amount,
           bt.description,
           bt.external_ref as "externalRef",
           bt.occurred_at as "occurredAt",
           bt.status,
           bt.created_at as "createdAt"
         from bank_transactions bt
         left join financial_accounts fa
           on fa.id = bt.account_id
          and fa.organization_id = bt.organization_id
         where bt.organization_id = $1
           and bt.status = 'pending'
         order by bt.occurred_at desc, bt.created_at desc
         limit $2`,
        [organizationId, limit],
      )

      const dueTodayAmount = dueTodayResult.rows.reduce(
        (sum, row) => sum + Number(row.amount ?? 0),
        0,
      )
      const overdueAmount = overdueResult.rows.reduce(
        (sum, row) => sum + Number(row.amount ?? 0),
        0,
      )

      return {
        generatedAt: new Date().toISOString(),
        installmentsDueToday: dueTodayResult.rows,
        installmentsOverdue: overdueResult.rows,
        pendingBankTransactions: pendingTransactionsResult.rows,
        summary: {
          dueTodayCount: dueTodayResult.rows.length,
          overdueCount: overdueResult.rows.length,
          pendingBankTransactionsCount: pendingTransactionsResult.rows.length,
          dueTodayAmount,
          overdueAmount,
        },
      }
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/installments/pay', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      installmentId: z.uuid(),
      accountId: z.uuid().optional(),
      amount: z.number().positive(),
      method: z.enum(PAYMENT_METHOD_VALUES).optional(),
      paidAt: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_installment_pay',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const result = await registerPayment(client, {
            organizationId,
            installmentId: data.installmentId,
            accountId: data.accountId ?? null,
            amount: data.amount,
            method: data.method ?? null,
            paidAt: data.paidAt ?? null,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'financial_installments',
            recordId: data.installmentId,
            newData: {
              ...result,
              accountId: data.accountId ?? null,
              amount: data.amount,
              method: data.method ?? 'other',
              paidAt: data.paidAt ?? null,
            },
            metadata: {
              source: 'finance.installment.pay',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/finance/bank-transactions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const directionRaw = normalizeOptionalQueryValue(request.query.direction)
    const statusRaw = normalizeOptionalQueryValue(request.query.status)
    const accountId = normalizeOptionalQueryValue(request.query.accountId)
    const from = normalizeOptionalQueryValue(request.query.from)
    const to = normalizeOptionalQueryValue(request.query.to)
    const query = normalizeOptionalQueryValue(request.query.query)
    const direction = isAllowedValue(directionRaw, ['in', 'out'] as const) ? directionRaw : ''
    const status = isAllowedValue(statusRaw, BANK_STATUS_VALUES) ? statusRaw : ''
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 50,
      maxLimit: 200,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from bank_transactions bt
         left join financial_accounts fa
           on fa.id = bt.account_id
          and fa.organization_id = bt.organization_id
         where bt.organization_id = $1
           and ($2 = '' or bt.direction::text = $2)
           and ($3 = '' or bt.status::text = $3)
           and ($4 = '' or bt.account_id::text = $4)
           and ($5 = '' or bt.occurred_at::date >= $5::date)
           and ($6 = '' or bt.occurred_at::date <= $6::date)
           and (
             $7 = ''
             or smart_search_match(lower(unaccent(coalesce(bt.description, ''))), $7, $8)
             or smart_search_match(lower(unaccent(coalesce(bt.external_ref, ''))), $7, $8)
             or smart_search_match(lower(unaccent(coalesce(fa.name, ''))), $7, $8)
           )`,
        [organizationId, direction, status, accountId, from, to, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select
           bt.id,
           bt.account_id as "accountId",
           fa.name as "accountName",
           bt.direction,
           bt.amount,
           bt.description,
           bt.external_ref as "externalRef",
           bt.occurred_at as "occurredAt",
           bt.status,
           bt.created_at as "createdAt"
         from bank_transactions bt
         left join financial_accounts fa
           on fa.id = bt.account_id
          and fa.organization_id = bt.organization_id
         where bt.organization_id = $1
           and ($2 = '' or bt.direction::text = $2)
           and ($3 = '' or bt.status::text = $3)
           and ($4 = '' or bt.account_id::text = $4)
           and ($5 = '' or bt.occurred_at::date >= $5::date)
           and ($6 = '' or bt.occurred_at::date <= $6::date)
           and (
             $7 = ''
             or smart_search_match(lower(unaccent(coalesce(bt.description, ''))), $7, $8)
             or smart_search_match(lower(unaccent(coalesce(bt.external_ref, ''))), $7, $8)
             or smart_search_match(lower(unaccent(coalesce(fa.name, ''))), $7, $8)
           )
         order by bt.occurred_at desc, bt.created_at desc
         limit $9
         offset $10`,
        [organizationId, direction, status, accountId, from, to, query, likeQuery, limit, offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/bank-transactions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      accountId: z.uuid().optional(),
      direction: z.enum(['in', 'out']),
      amount: z.number().positive(),
      description: z.string().optional(),
      externalRef: z.string().optional(),
      occurredAt: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_bank_transaction_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          if (data.accountId) {
            const accountResult = await client.query(
              `select 1
               from financial_accounts
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.accountId],
            )
            if ((accountResult.rowCount ?? 0) === 0) {
              throw new Error('Conta financeira não pertence à organização.')
            }
          }

          const result = await createBankTransaction(client, {
            organizationId,
            accountId: data.accountId ?? null,
            direction: data.direction,
            amount: data.amount,
            description: data.description ?? null,
            externalRef: data.externalRef ?? null,
            occurredAt: data.occurredAt ?? null,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'bank_transactions',
            recordId: result.bankTransactionId,
            newData: {
              bankTransactionId: result.bankTransactionId,
              accountId: data.accountId ?? null,
              direction: data.direction,
              amount: data.amount,
              description: data.description ?? null,
              externalRef: data.externalRef ?? null,
              occurredAt: data.occurredAt ?? null,
              status: 'pending',
            },
            metadata: {
              source: 'finance.bankTransaction.create',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/ofx/import', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      accountId: z.uuid().optional(),
      rawText: z.string().min(1),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_ofx_import',
        idempotencyKey,
        requestBody: {
          accountId: data.accountId ?? null,
          rawTextHash: hashText(data.rawText),
          rawTextPreview: data.rawText.slice(0, 40),
        },
        execute: async () => {
          if (data.accountId) {
            const accountResult = await client.query(
              `select 1
               from financial_accounts
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.accountId],
            )
            if ((accountResult.rowCount ?? 0) === 0) {
              throw new Error('Conta financeira não pertence à organização.')
            }
          }

          const result = await importOfx(client, {
            organizationId,
            accountId: data.accountId ?? null,
            rawText: data.rawText,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'ofx_imports',
            recordId: result.importId,
            newData: {
              importId: result.importId,
              accountId: data.accountId ?? null,
              totalCount: result.totalCount,
              importedCount: result.importedCount,
              ignoredCount: result.ignoredCount,
            },
            metadata: {
              source: 'finance.ofx.import',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/finance/reconciliation/activity', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 8,
      maxLimit: 50,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      try {
        const countResult = await client.query<{ total: number }>(
          `select count(*)::int as total
           from audit_log al
           where al.organization_id = $1
             and al.table_name in ('bank_transactions', 'ofx_imports')
             and coalesce(al.metadata->>'source', '') = any($2::text[])`,
          [organizationId, RECONCILIATION_ACTIVITY_SOURCES],
        )

        const rowsResult = await client.query(
          `select
             al.id,
             al.created_at as "createdAt",
             coalesce(p.full_name, p.email) as "actorName",
             coalesce(al.metadata->>'source', '') as source,
             (al.new_data->>'bankTransactionId') as "bankTransactionId",
             bt.description as "bankTransactionDescription",
             bt.amount as "bankTransactionAmount",
             bt.direction::text as "bankTransactionDirection",
             (al.new_data->>'reconciliationItemId') as "reconciliationItemId",
             (al.new_data->>'importId') as "importId",
             nullif(al.new_data->>'totalCount', '')::int as "totalCount",
             nullif(al.new_data->>'importedCount', '')::int as "importedCount",
             nullif(al.new_data->>'ignoredCount', '')::int as "ignoredCount",
             (al.new_data->>'installmentId') as "installmentId",
             fi.amount as "installmentAmount",
             ft.title_type::text as "installmentTitleType"
           from audit_log al
           left join profiles p
             on p.id = al.actor_user_id
           left join bank_transactions bt
             on bt.organization_id = al.organization_id
            and bt.id = nullif(al.new_data->>'bankTransactionId', '')::uuid
           left join financial_installments fi
             on fi.organization_id = al.organization_id
            and fi.id = nullif(al.new_data->>'installmentId', '')::uuid
           left join financial_titles ft
             on ft.organization_id = fi.organization_id
            and ft.id = fi.title_id
           where al.organization_id = $1
             and al.table_name in ('bank_transactions', 'ofx_imports')
             and coalesce(al.metadata->>'source', '') = any($2::text[])
           order by al.created_at desc
           limit $3
           offset $4`,
          [organizationId, RECONCILIATION_ACTIVITY_SOURCES, limit, offset],
        )

        return {
          rows: rowsResult.rows,
          total: Number(countResult.rows[0]?.total ?? 0),
        }
      } catch (error) {
        if (isPgErrorWithCode(error, '42P01')) {
          return {
            rows: [],
            total: 0,
          }
        }
        throw error
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/reconcile', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      bankTransactionId: z.uuid(),
      installmentId: z.uuid().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      const membership = await assertOrgMember(client, organizationId, user.id)
      if (!hasAdvancedReconcilePermission(membership.role)) {
        throw new Error('Somente usuários com perfil de gestão podem usar conciliação sem baixa.')
      }

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_reconcile_manual',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const txResult = await client.query<{
            id: string
            account_id: string | null
            direction: 'in' | 'out'
            amount: string | number
            status: string
          }>(
            `select id,
                    account_id,
                    direction::text as direction,
                    amount,
                    status::text as status
             from bank_transactions
             where organization_id = $1
               and id = $2
             limit 1
             for update`,
            [organizationId, data.bankTransactionId],
          )

          if ((txResult.rowCount ?? 0) === 0) {
            throw new Error('Transação bancária não encontrada.')
          }

          const tx = txResult.rows[0]
          if (tx.status === 'reconciled') {
            throw new Error('Transação bancária já conciliada.')
          }

          if (tx.status !== 'pending') {
            throw new Error('Apenas transações pendentes podem ser conciliadas.')
          }

          if (data.installmentId) {
            const installmentResult = await client.query<{
              id: string
              amount: string | number
              status: string
              title_type: 'receivable' | 'payable'
            }>(
              `select fi.id,
                      fi.amount,
                      fi.status::text as status,
                      ft.title_type::text as title_type
               from financial_installments fi
               join financial_titles ft
                 on ft.organization_id = fi.organization_id
                and ft.id = fi.title_id
               where fi.organization_id = $1
                 and fi.id = $2
               limit 1
               for update`,
              [organizationId, data.installmentId],
            )

            if ((installmentResult.rowCount ?? 0) === 0) {
              throw new Error('Parcela para conciliação não encontrada.')
            }

            const installment = installmentResult.rows[0]
            if (installment.status !== 'open') {
              throw new Error('Somente parcelas abertas podem ser conciliadas.')
            }

            const expectedDirection = installment.title_type === 'receivable' ? 'in' : 'out'
            if (tx.direction !== expectedDirection) {
              throw new Error('Direção da transação bancária não compatível com a parcela informada.')
            }

            const installmentAmount = Number(installment.amount ?? 0)
            const txAmount = Number(tx.amount ?? 0)
            if (Math.abs(installmentAmount - txAmount) > 0.01) {
              throw new Error('Valor da parcela difere da transação bancária além da tolerância (0,01).')
            }
          }

          const reconciliationResult = await client.query<{ id: string }>(
            `insert into bank_reconciliations (organization_id, account_id)
             values ($1, $2)
             returning id`,
            [organizationId, tx.account_id],
          )

          const reconciliationId = reconciliationResult.rows[0].id

          const reconItemResult = await client.query<{ id: string }>(
            `insert into bank_reconciliation_items
              (organization_id, reconciliation_id, bank_transaction_id, installment_id)
             values ($1, $2, $3, $4)
             returning id`,
            [organizationId, reconciliationId, data.bankTransactionId, data.installmentId ?? null],
          )

          await client.query(
            `update bank_transactions
             set status = 'reconciled'
             where organization_id = $1
               and id = $2`,
            [organizationId, data.bankTransactionId],
          )

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'bank_transactions',
            recordId: data.bankTransactionId,
            newData: {
              bankTransactionId: data.bankTransactionId,
              status: 'reconciled',
              installmentId: data.installmentId ?? null,
              reconciliationId,
              reconciliationItemId: reconItemResult.rows[0].id,
            },
            metadata: {
              source: 'finance.reconcile.manual',
            },
          })

          return {
            status: 201,
            body: { reconciliationItemId: reconItemResult.rows[0].id },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/reconcile/settle', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      bankTransactionId: z.uuid(),
      installmentId: z.uuid(),
      method: z.enum(PAYMENT_METHOD_VALUES).optional(),
      paidAt: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation<{
        reconciliationItemId: string
        installmentId: string
        titleId: string
      }>({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_reconcile_settle',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const txResult = await client.query<{
            id: string
            account_id: string | null
            direction: 'in' | 'out'
            amount: string | number
            status: string
            occurred_at: string | null
          }>(
            `select id,
                    account_id,
                    direction::text as direction,
                    amount,
                    status::text as status,
                    occurred_at
             from bank_transactions
             where organization_id = $1
               and id = $2
             limit 1
             for update`,
            [organizationId, data.bankTransactionId],
          )

          if ((txResult.rowCount ?? 0) === 0) {
            throw new Error('Transação bancária não encontrada.')
          }

          const tx = txResult.rows[0]
          if (tx.status === 'reconciled') {
            throw new Error('Transação bancária já conciliada.')
          }

          if (tx.status !== 'pending') {
            throw new Error('Apenas transações pendentes podem ser conciliadas.')
          }

          const installmentResult = await client.query<{
            id: string
            amount: string | number
            status: string
            title_type: 'receivable' | 'payable'
          }>(
            `select fi.id,
                    fi.amount,
                    fi.status::text as status,
                    ft.title_type::text as title_type
             from financial_installments fi
             join financial_titles ft
               on ft.organization_id = fi.organization_id
              and ft.id = fi.title_id
             where fi.organization_id = $1
               and fi.id = $2
             limit 1
             for update`,
            [organizationId, data.installmentId],
          )

          if ((installmentResult.rowCount ?? 0) === 0) {
            throw new Error('Parcela para conciliação não encontrada.')
          }

          const installment = installmentResult.rows[0]
          if (installment.status !== 'open') {
            throw new Error('Somente parcelas abertas podem ser conciliadas.')
          }

          const expectedDirection = installment.title_type === 'receivable' ? 'in' : 'out'
          if (tx.direction !== expectedDirection) {
            throw new Error('Direção da transação bancária não compatível com a parcela informada.')
          }

          const installmentAmount = Number(installment.amount ?? 0)
          const txAmount = Number(tx.amount ?? 0)
          if (!Number.isFinite(txAmount) || txAmount <= 0) {
            throw new Error('Valor da transação bancária inválido para conciliação.')
          }

          if (Math.abs(installmentAmount - txAmount) > 0.01) {
            throw new Error('Valor da parcela difere da transação bancária além da tolerância (0,01).')
          }

          const paymentResult = await registerPayment(client, {
            organizationId,
            installmentId: data.installmentId,
            accountId: tx.account_id ?? null,
            amount: txAmount,
            method: data.method ?? 'transfer',
            paidAt: data.paidAt ?? tx.occurred_at ?? null,
          })

          const reconciliationResult = await client.query<{ id: string }>(
            `insert into bank_reconciliations (organization_id, account_id)
             values ($1, $2)
             returning id`,
            [organizationId, tx.account_id],
          )

          const reconciliationId = reconciliationResult.rows[0].id

          const reconItemResult = await client.query<{ id: string }>(
            `insert into bank_reconciliation_items
              (organization_id, reconciliation_id, bank_transaction_id, installment_id)
             values ($1, $2, $3, $4)
             returning id`,
            [organizationId, reconciliationId, data.bankTransactionId, data.installmentId],
          )

          await client.query(
            `update bank_transactions
             set status = 'reconciled'
             where organization_id = $1
               and id = $2`,
            [organizationId, data.bankTransactionId],
          )

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'bank_transactions',
            recordId: data.bankTransactionId,
            newData: {
              bankTransactionId: data.bankTransactionId,
              status: 'reconciled',
              installmentId: data.installmentId,
              reconciliationId,
              reconciliationItemId: reconItemResult.rows[0].id,
              paymentMethod: paymentResult.paymentMethod,
              signedAmount: paymentResult.signedAmount,
            },
            metadata: {
              source: 'finance.reconcile.settle',
            },
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'financial_installments',
            recordId: data.installmentId,
            newData: {
              installmentId: data.installmentId,
              status: 'paid',
              reconciliationItemId: reconItemResult.rows[0].id,
            },
            metadata: {
              source: 'finance.reconcile.settle',
            },
          })

          return {
            status: 201,
            body: {
              reconciliationItemId: reconItemResult.rows[0].id,
              installmentId: data.installmentId,
              titleId: paymentResult.titleId,
            },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/reconcile/adjustment', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      bankTransactionId: z.uuid(),
      adjustmentType: z.enum(RECONCILIATION_ADJUSTMENT_TYPES).optional(),
      description: z.string().max(280).optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation<{
        reconciliationItemId: string
        cashFlowEntryId: string
      }>({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_reconcile_adjustment',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          const txResult = await client.query<{
            id: string
            account_id: string | null
            direction: 'in' | 'out'
            amount: string | number
            status: string
            occurred_at: string | null
            description: string | null
          }>(
            `select id,
                    account_id,
                    direction::text as direction,
                    amount,
                    status::text as status,
                    occurred_at,
                    description
             from bank_transactions
             where organization_id = $1
               and id = $2
             limit 1
             for update`,
            [organizationId, data.bankTransactionId],
          )

          if ((txResult.rowCount ?? 0) === 0) {
            throw new Error('Transação bancária não encontrada.')
          }

          const tx = txResult.rows[0]
          if (tx.status === 'reconciled') {
            throw new Error('Transação bancária já conciliada.')
          }

          if (tx.status !== 'pending') {
            throw new Error('Apenas transações pendentes podem ser conciliadas.')
          }

          const amount = Number(tx.amount ?? 0)
          if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Valor da transação bancária inválido para ajuste.')
          }

          const signedAmount = tx.direction === 'out' ? -Math.abs(amount) : Math.abs(amount)
          const adjustmentType = data.adjustmentType ?? 'other'
          const detail = adjustmentTypeLabel(adjustmentType)
          const fallbackDescription = tx.description?.trim() ?? ''
          const normalizedDescription = data.description?.trim() || fallbackDescription
          const flowDescription = normalizedDescription
            ? `Ajuste de conciliação (${detail}): ${normalizedDescription}`
            : `Ajuste de conciliação (${detail})`

          const cashFlowResult = await client.query<{ id: string }>(
            `insert into cash_flow_entries
              (organization_id, account_id, title_id, entry_date, amount, description)
             values ($1, $2, null, coalesce($3::date, current_date), $4, $5)
             returning id`,
            [organizationId, tx.account_id, tx.occurred_at, signedAmount, flowDescription],
          )

          const reconciliationResult = await client.query<{ id: string }>(
            `insert into bank_reconciliations (organization_id, account_id)
             values ($1, $2)
             returning id`,
            [organizationId, tx.account_id],
          )

          const reconciliationId = reconciliationResult.rows[0].id

          const reconItemResult = await client.query<{ id: string }>(
            `insert into bank_reconciliation_items
              (organization_id, reconciliation_id, bank_transaction_id, installment_id)
             values ($1, $2, $3, null)
             returning id`,
            [organizationId, reconciliationId, data.bankTransactionId],
          )

          await client.query(
            `update bank_transactions
             set status = 'reconciled'
             where organization_id = $1
               and id = $2`,
            [organizationId, data.bankTransactionId],
          )

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'cash_flow_entries',
            recordId: cashFlowResult.rows[0].id,
            newData: {
              cashFlowEntryId: cashFlowResult.rows[0].id,
              accountId: tx.account_id,
              amount: signedAmount,
              description: flowDescription,
              sourceBankTransactionId: data.bankTransactionId,
            },
            metadata: {
              source: 'finance.reconcile.adjustment',
              adjustmentType,
            },
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'bank_transactions',
            recordId: data.bankTransactionId,
            newData: {
              bankTransactionId: data.bankTransactionId,
              status: 'reconciled',
              reconciliationId,
              reconciliationItemId: reconItemResult.rows[0].id,
              cashFlowEntryId: cashFlowResult.rows[0].id,
              adjustmentType,
            },
            metadata: {
              source: 'finance.reconcile.adjustment',
            },
          })

          return {
            status: 201,
            body: {
              reconciliationItemId: reconItemResult.rows[0].id,
              cashFlowEntryId: cashFlowResult.rows[0].id,
            },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/reconcile/auto', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      accountId: z.uuid().optional(),
      tolerance: z.number().nonnegative().optional(),
    })
    const data = schema.parse(request.body)
    const tolerance = Number.isFinite(data.tolerance) ? Number(data.tolerance) : 0.01

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation<{ matched: number; reconciliationId: string | null }>({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_reconcile_auto',
        idempotencyKey,
        requestBody: {
          accountId: data.accountId ?? null,
          tolerance,
        },
        execute: async () => {
          if (data.accountId) {
            const accountResult = await client.query(
              `select 1
               from financial_accounts
               where organization_id = $1
                 and id = $2
               limit 1`,
              [organizationId, data.accountId],
            )
            if ((accountResult.rowCount ?? 0) === 0) {
              throw new Error('Conta financeira não pertence à organização.')
            }
          }

          const txResult = await client.query<{
            id: string
            amount: string | number
            direction: 'in' | 'out'
            account_id: string | null
          }>(
            `select id,
                    amount,
                    direction::text as direction,
                    account_id
             from bank_transactions
             where organization_id = $1
               and status = 'pending'
               and ($2::uuid is null or account_id = $2)
             order by occurred_at desc
             limit 50
             for update`,
            [organizationId, data.accountId ?? null],
          )

          if (txResult.rows.length === 0) {
            return {
              status: 201,
              body: {
                matched: 0,
                reconciliationId: null,
              },
            }
          }

          const installmentsResult = await client.query<{
            id: string
            amount: string | number
            title_type: 'receivable' | 'payable'
          }>(
            `select fi.id,
                    fi.amount,
                    ft.title_type::text as title_type
             from financial_installments fi
             join financial_titles ft
               on ft.organization_id = fi.organization_id
              and ft.id = fi.title_id
             where fi.organization_id = $1
               and fi.status = 'open'
             order by fi.due_date asc
             for update`,
            [organizationId],
          )

          const reconciliationResult = await client.query<{ id: string }>(
            `insert into bank_reconciliations (organization_id, account_id, ofx_reference)
             values ($1, $2, $3)
             returning id`,
            [organizationId, data.accountId ?? null, `auto:${new Date().toISOString()}`],
          )

          const reconciliationId = reconciliationResult.rows[0].id
          const usedInstallments = new Set<string>()
          let matched = 0

          for (const tx of txResult.rows) {
            const expectedTitleType = tx.direction === 'in' ? 'receivable' : 'payable'
            const txAmount = Number(tx.amount ?? 0)

            const candidate = installmentsResult.rows.find((installment) => {
              if (usedInstallments.has(installment.id)) return false
              if (installment.title_type !== expectedTitleType) return false
              const installmentAmount = Number(installment.amount ?? 0)
              return Math.abs(installmentAmount - txAmount) <= tolerance
            })

            if (!candidate) {
              continue
            }

            await client.query(
              `insert into bank_reconciliation_items
                (organization_id, reconciliation_id, bank_transaction_id, installment_id)
               values ($1, $2, $3, $4)`,
              [organizationId, reconciliationId, tx.id, candidate.id],
            )

            await client.query(
              `update bank_transactions
               set status = 'reconciled'
               where organization_id = $1
                 and id = $2`,
              [organizationId, tx.id],
            )

            usedInstallments.add(candidate.id)
            matched += 1
          }

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'update',
            tableName: 'bank_reconciliations',
            recordId: reconciliationId,
            newData: {
              reconciliationId,
              matched,
              accountId: data.accountId ?? null,
              tolerance,
            },
            metadata: {
              source: 'finance.reconcile.auto',
            },
          })

          return {
            status: 201,
            body: {
              matched,
              reconciliationId,
            },
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/finance/payment-requests', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const idempotencyKey = request.header('idempotency-key')
    const schema = z.object({
      titleId: z.uuid().optional(),
      provider: z.enum(['pix', 'boleto', 'bank_api']),
      amount: z.number().positive(),
      payload: z.record(z.string(), z.unknown()).optional(),
    })
    const data = schema.parse(request.body)

    const mutation = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      return runIdempotentMutation({
        client,
        organizationId,
        actorUserId: user.id,
        operation: 'finance_payment_request_create',
        idempotencyKey,
        requestBody: data,
        execute: async () => {
          if (data.titleId) {
            const titleResult = await client.query(
              `select 1
               from financial_titles
               where organization_id = $1
                 and id = $2
                 and title_type = 'receivable'
               limit 1`,
              [organizationId, data.titleId],
            )
            if ((titleResult.rowCount ?? 0) === 0) {
              throw new Error('Título para cobrança deve ser da organização e do tipo a receber.')
            }
          }

          const result = await createPaymentRequest(client, {
            organizationId,
            titleId: data.titleId ?? null,
            provider: data.provider,
            amount: data.amount,
            payload: data.payload ?? null,
          })

          await recordAuditLog({
            client,
            organizationId,
            actorUserId: user.id,
            operation: 'insert',
            tableName: 'payment_requests',
            recordId: result.paymentRequestId,
            newData: {
              paymentRequestId: result.paymentRequestId,
              titleId: data.titleId ?? null,
              provider: data.provider,
              amount: data.amount,
              status: 'created',
            },
            metadata: {
              source: 'finance.paymentRequest.create',
            },
          })

          return {
            status: 201,
            body: result,
          }
        },
      })
    })

    setReplayHeaderIfNeeded(response, mutation.replayed)
    response.status(mutation.status).json(mutation.body)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export { router as financeRoutes }
