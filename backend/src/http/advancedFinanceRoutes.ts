import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { recordAuditLog, runIdempotentMutation } from './mutationSafety'

const router = Router()

function normalizeOpt(v: unknown) { return typeof v === 'string' ? v.trim() : '' }
function parseLO(q: Record<string, unknown>, def = 30, max = 200) {
  const l = Number.parseInt(typeof q.limit === 'string' ? q.limit : '', 10)
  const o = Number.parseInt(typeof q.offset === 'string' ? q.offset : '', 10)
  return { limit: Number.isFinite(l) ? Math.min(Math.max(l, 1), max) : def, offset: Number.isFinite(o) ? Math.max(o, 0) : 0 }
}

// ══════════════════════════════════════════════════════════════════════════════
// COST CENTERS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/finance/cost-centers', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, code, name, center_type as "centerType", parent_id as "parentId", active, created_at as "createdAt"
         from cost_centers where organization_id=$1 order by code asc`, [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/finance/cost-centers', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const idemKey = req.header('idempotency-key')
    const data = z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      centerType: z.enum(['cost', 'profit']).optional(),
      parentId: z.string().uuid().optional(),
    }).parse(req.body)
    const mutation = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      return runIdempotentMutation({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'cost_center_create', idempotencyKey: idemKey, requestBody: data,
        execute: async () => {
          const r = await c.query(
            `insert into cost_centers (organization_id, code, name, center_type, parent_id)
             values ($1,$2,$3,$4,$5) returning id`,
            [orgId, data.code, data.name, data.centerType ?? 'cost', data.parentId ?? null])
          await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
            operation: 'insert', tableName: 'cost_centers', recordId: r.rows[0].id as string,
            newData: data, metadata: { source: 'finance.cost-center.create' } })
          return { status: 201 as const, body: { id: r.rows[0].id } }
        }
      })
    })
    res.status(mutation.status).json(mutation.body)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// BILLING RULES (Régua de Cobrança)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/finance/billing-rules', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, name, days_offset as "daysOffset", channel, template_subject as "templateSubject",
                template_body as "templateBody", active, created_at as "createdAt"
         from billing_rules where organization_id=$1 order by days_offset asc`, [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/finance/billing-rules', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      name: z.string().min(1),
      daysOffset: z.number().int(),
      channel: z.enum(['email', 'whatsapp', 'sms', 'internal']).optional(),
      templateSubject: z.string().optional(),
      templateBody: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into billing_rules (organization_id, name, days_offset, channel, template_subject, template_body)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [orgId, data.name, data.daysOffset, data.channel ?? 'email', data.templateSubject ?? null, data.templateBody ?? null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/finance/billing-rules/execute', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      // Get active rules
      const rules = await c.query(
        `select id, days_offset, channel from billing_rules where organization_id=$1 and active=true`, [orgId])
      let sent = 0
      const skipped = 0
      for (const rule of rules.rows) {
        const offset = Number(rule.days_offset)
        const targetDate = offset >= 0
          ? `current_date - interval '${offset} days'`
          : `current_date + interval '${Math.abs(offset)} days'`
        // Find installments matching this rule
        const installments = await c.query(
          `select fi.id from financial_installments fi
           join financial_titles ft on ft.id=fi.title_id and ft.organization_id=fi.organization_id
           where fi.organization_id=$1 and fi.status='open' and fi.due_date=${targetDate}
             and not exists (
               select 1 from billing_rule_executions bre
               where bre.organization_id=$1 and bre.rule_id=$2 and bre.installment_id=fi.id
             )`, [orgId, rule.id])
        for (const inst of installments.rows) {
          await c.query(
            `insert into billing_rule_executions (organization_id, rule_id, installment_id, channel, status)
             values ($1,$2,$3,$4,'sent')`, [orgId, rule.id, inst.id, rule.channel])
          sent++
        }
      }
      return { sent, skipped, rulesEvaluated: rules.rows.length }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// CNAB RETURN PROCESSING
// ══════════════════════════════════════════════════════════════════════════════
router.post('/finance/cnab-return/upload', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      fileName: z.string().min(1),
      bankCode: z.string().optional(),
      format: z.enum(['240', '400']).optional(),
      entries: z.array(z.object({
        lineNumber: z.number().int(),
        nossoNumero: z.string().optional(),
        valorPago: z.number().nonnegative(),
        dataCredito: z.string().optional(),
        dataOcorrencia: z.string().optional(),
        codigoOcorrencia: z.string().optional(),
      })).min(1, 'Arquivo de retorno precisa conter ao menos uma entrada.'),
    }).parse(req.body)

    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const retorno = await c.query(
        `insert into cnab_returns (organization_id, file_name, bank_code, format, total_entries, uploaded_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [orgId, data.fileName, data.bankCode ?? null, data.format ?? '240', data.entries.length, user.id])
      const returnId = retorno.rows[0].id as string
      let matched = 0; const errors = 0
      for (const entry of data.entries) {
        // Try to match by nosso_numero
        let installmentId: string | null = null
        let status = 'pending'
        if (entry.nossoNumero) {
          const match = await c.query(
            `select fi.id from financial_installments fi
             join financial_titles ft on ft.id=fi.title_id and ft.organization_id=fi.organization_id
             where fi.organization_id=$1 and fi.status='open'
               and fi.nosso_numero=$2 limit 1`,
            [orgId, entry.nossoNumero])
          if ((match.rowCount ?? 0) > 0) {
            installmentId = match.rows[0].id as string
            status = 'matched'
            matched++
          }
        }
        await c.query(
          `insert into cnab_return_entries
            (organization_id, return_id, line_number, nosso_numero, valor_pago, data_credito, data_ocorrencia, codigo_ocorrencia, status, installment_id)
           values ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10)`,
          [orgId, returnId, entry.lineNumber, entry.nossoNumero ?? null, entry.valorPago,
           entry.dataCredito ?? null, entry.dataOcorrencia ?? null, entry.codigoOcorrencia ?? null,
           status, installmentId])
      }
      await c.query(`update cnab_returns set processed_count=$3, error_count=$4 where organization_id=$1 and id=$2`,
        [orgId, returnId, matched, errors])
      return { returnId, totalEntries: data.entries.length, matched, errors }
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/finance/cnab-return/:id/process', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const returnId = req.params.id
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      // Process matched entries - pay installments
      const entries = await c.query(
        `select id, installment_id, valor_pago, data_credito
         from cnab_return_entries where organization_id=$1 and return_id=$2 and status='matched'`,
        [orgId, returnId])
      let paid = 0
      for (const entry of entries.rows) {
        if (!entry.installment_id) continue
        await c.query(
          `update financial_installments set status='paid', paid_at=coalesce($3::date, current_date), paid_amount=$4
           where organization_id=$1 and id=$2 and status='open'`,
          [orgId, entry.installment_id, entry.data_credito, entry.valor_pago])
        await c.query(`update cnab_return_entries set status='paid' where organization_id=$1 and id=$2`,
          [orgId, entry.id])
        paid++
      }
      await c.query(`update cnab_returns set processed_count=$3, processed_at=now() where organization_id=$1 and id=$2`,
        [orgId, returnId, paid])
      return { processed: paid }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/finance/cnab-returns', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, file_name as "fileName", bank_code as "bankCode", format, total_entries as "totalEntries",
                processed_count as "processedCount", error_count as "errorCount",
                processed_at as "processedAt", created_at as "createdAt"
         from cnab_returns where organization_id=$1
         order by created_at desc limit $2 offset $3`, [orgId, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// DRE POR COMPETÊNCIA
// ══════════════════════════════════════════════════════════════════════════════
router.get('/reports/dre-accrual', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const from = normalizeOpt(req.query.from)
    const to = normalizeOpt(req.query.to)
    const costCenterId = normalizeOpt(req.query.costCenterId)
    const result = await withOrgRead(orgId, (c) =>
      c.query(
        `select title_type,
                date_trunc('month', coalesce(competence_date, created_at::date))::date as month,
                sum(total_amount) as total
         from financial_titles
         where organization_id=$1
           and ($2='' or coalesce(competence_date, created_at::date) >= $2::date)
           and ($3='' or coalesce(competence_date, created_at::date) <= $3::date)
           and ($4='' or cost_center_id::text=$4)
         group by title_type, month
         order by month desc, title_type`,
        [orgId, from, to, costCenterId]))
    res.json(result.rows)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

export { router as advancedFinanceRoutes }
