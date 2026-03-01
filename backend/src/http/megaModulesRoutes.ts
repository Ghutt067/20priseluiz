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
// MODULE 5: AUDITORIA AVANÇADA — Shadow Tables + Approval Workflow
// ══════════════════════════════════════════════════════════════════════════════

// Record Versions (Shadow/History)
router.get('/audit/versions', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const tableName = normalizeOpt(req.query.tableName)
    const recordId = normalizeOpt(req.query.recordId)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, table_name as "tableName", record_id as "recordId", version_number as "versionNumber",
                old_data as "oldData", new_data as "newData", changed_fields as "changedFields",
                operation, actor_user_id as "actorUserId", created_at as "createdAt"
         from record_versions
         where organization_id=$1 and ($2='' or table_name=$2) and ($3='' or record_id::text=$3)
         order by created_at desc limit $4 offset $5`,
        [orgId, tableName, recordId, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Approval Rules CRUD
router.get('/audit/approval-rules', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, entity_type as "entityType", field_name as "fieldName",
                threshold, required_role as "requiredRole", active, created_at as "createdAt"
         from approval_rules where organization_id=$1 order by entity_type, threshold`, [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/audit/approval-rules', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      entityType: z.string().min(1),
      fieldName: z.string().optional(),
      threshold: z.number().positive(),
      requiredRole: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into approval_rules (organization_id, entity_type, field_name, threshold, required_role)
         values ($1,$2,$3,$4,$5) returning id`,
        [orgId, data.entityType, data.fieldName ?? 'total_amount', data.threshold, data.requiredRole ?? 'chefe'])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Approval Requests
router.get('/audit/approval-requests', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select ar.id, ar.entity_type as "entityType", ar.record_id as "recordId",
                ar.field_value as "fieldValue", ar.status, ar.notes,
                ar.requester_user_id as "requesterUserId", ar.approver_user_id as "approverUserId",
                ar.decided_at as "decidedAt", ar.expires_at as "expiresAt", ar.created_at as "createdAt",
                rl.threshold, rl.required_role as "requiredRole"
         from approval_requests ar
         join approval_rules rl on rl.id=ar.rule_id
         where ar.organization_id=$1 and ($2='' or ar.status=$2)
         order by ar.created_at desc limit $3 offset $4`,
        [orgId, status, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/audit/approval-requests/:id/decide', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const requestId = req.params.id
    const data = z.object({
      decision: z.enum(['approved', 'rejected']),
      notes: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      const { role } = await assertOrgMember(c, orgId, user.id)
      const ar = await c.query(
        `select id, status, expires_at from approval_requests
         where organization_id=$1 and id=$2 for update`, [orgId, requestId])
      if ((ar.rowCount ?? 0) === 0) throw new Error('Solicitação não encontrada.')
      if (ar.rows[0].status !== 'pending') throw new Error('Solicitação já decidida.')
      if (new Date(ar.rows[0].expires_at) < new Date()) throw new Error('Solicitação expirada.')
      // Check approver has required role
      const rule = await c.query(
        `select required_role from approval_rules ar2
         join approval_requests ar on ar.rule_id=ar2.id
         where ar.organization_id=$1 and ar.id=$2`, [orgId, requestId])
      const requiredRole = rule.rows[0]?.required_role ?? 'chefe'
      if (role !== requiredRole && role !== 'chefe') throw new Error('Sem permissão para aprovar.')
      await c.query(
        `update approval_requests set status=$3, approver_user_id=$4, notes=$5, decided_at=now()
         where organization_id=$1 and id=$2`, [orgId, requestId, data.decision, user.id, data.notes ?? null])
      await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'update', tableName: 'approval_requests', recordId: requestId,
        newData: { decision: data.decision }, metadata: { source: 'audit.approval.decide' } })
      return { decided: data.decision }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 6: IA — Churn Prediction + Anomaly Detection
// ══════════════════════════════════════════════════════════════════════════════

router.post('/ai/calculate-churn', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      // Calculate churn risk for all customers
      const customers = await c.query(
        `select c.id,
                extract(day from now() - max(so.created_at))::int as days_since,
                count(so.id)::int as order_count,
                coalesce(avg(so.total_amount), 0) as avg_ticket,
                case when count(so.id) > 1
                  then extract(day from max(so.created_at) - min(so.created_at))::numeric / (count(so.id) - 1)
                  else null end as freq_days
         from customers c
         left join sales_orders so on so.customer_id=c.id and so.organization_id=c.organization_id
         where c.organization_id=$1
         group by c.id`, [orgId])
      let calculated = 0
      for (const cust of customers.rows) {
        const daysSince = Number(cust.days_since ?? 999)
        const freq = Number(cust.freq_days ?? 90)
        const orderCount = Number(cust.order_count ?? 0)
        // Simple heuristic: score 0-100
        let score = 0
        if (orderCount === 0) { score = 90 }
        else if (daysSince > freq * 3) { score = 85 }
        else if (daysSince > freq * 2) { score = 65 }
        else if (daysSince > freq * 1.5) { score = 40 }
        else { score = Math.max(10, Math.min(30, daysSince / freq * 30)) }
        const riskLevel = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
        // Upsert churn score
        await c.query(
          `insert into churn_scores (organization_id, customer_id, score, risk_level, days_since_last_purchase, purchase_frequency_days, avg_ticket, calculated_at)
           values ($1,$2,$3,$4,$5,$6,$7,now())
           on conflict (organization_id, customer_id)
           do update set score=$3, risk_level=$4, days_since_last_purchase=$5, purchase_frequency_days=$6, avg_ticket=$7, calculated_at=now()`,
          [orgId, cust.id, score, riskLevel, daysSince, freq, cust.avg_ticket])
        calculated++
      }
      return { calculated }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/ai/churn-risk', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const riskLevel = normalizeOpt(req.query.riskLevel)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select cs.id, cs.customer_id as "customerId", c.name as "customerName",
                cs.score, cs.risk_level as "riskLevel",
                cs.days_since_last_purchase as "daysSinceLastPurchase",
                cs.purchase_frequency_days as "purchaseFrequencyDays",
                cs.avg_ticket as "avgTicket", cs.calculated_at as "calculatedAt"
         from churn_scores cs
         join customers c on c.id=cs.customer_id and c.organization_id=cs.organization_id
         where cs.organization_id=$1 and ($2='' or cs.risk_level=$2)
         order by cs.score desc limit $3 offset $4`,
        [orgId, riskLevel, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/ai/detect-anomalies', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      // Detect financial anomalies: entries with amount > 3 standard deviations from user's mean
      const anomalies = await c.query(
        `with user_stats as (
           select actor_user_id,
                  avg((new_data->>'totalAmount')::numeric) as mean_amount,
                  stddev((new_data->>'totalAmount')::numeric) as std_amount
           from audit_log
           where organization_id=$1 and table_name in ('financial_titles','sales_orders')
             and new_data->>'totalAmount' is not null
           group by actor_user_id
           having count(*) >= 5
         )
         select al.id as record_id, al.table_name as entity_type,
                (al.new_data->>'totalAmount')::numeric as amount,
                us.mean_amount, us.std_amount,
                abs((al.new_data->>'totalAmount')::numeric - us.mean_amount) / nullif(us.std_amount, 0) as z_score
         from audit_log al
         join user_stats us on us.actor_user_id=al.actor_user_id
         where al.organization_id=$1
           and al.created_at > now() - interval '7 days'
           and al.new_data->>'totalAmount' is not null
           and abs((al.new_data->>'totalAmount')::numeric - us.mean_amount) / nullif(us.std_amount, 0) > 3
         order by z_score desc
         limit 20`,
        [orgId])
      let created = 0
      for (const row of anomalies.rows) {
        const exists = await c.query(
          `select id from anomaly_alerts where organization_id=$1 and entity_type=$2 and record_id=$3`,
          [orgId, row.entity_type, row.record_id])
        if ((exists.rowCount ?? 0) === 0) {
          await c.query(
            `insert into anomaly_alerts (organization_id, alert_type, entity_type, record_id, description, severity)
             values ($1,'financial_amount',$2,$3,$4,$5)`,
            [orgId, row.entity_type, row.record_id,
             `Valor ${Number(row.amount).toFixed(2)} está ${Number(row.z_score).toFixed(1)} desvios padrão acima da média`,
             Math.min(Number(row.z_score) * 20, 100)])
          created++
        }
      }
      return { alertsCreated: created, anomaliesFound: anomalies.rows.length }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/ai/anomaly-alerts', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const reviewed = normalizeOpt(req.query.reviewed)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, alert_type as "alertType", entity_type as "entityType", record_id as "recordId",
                description, severity, reviewed, reviewed_by as "reviewedBy", created_at as "createdAt"
         from anomaly_alerts
         where organization_id=$1 and ($2='' or reviewed=($2='true'))
         order by created_at desc limit $3 offset $4`,
        [orgId, reviewed, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.patch('/ai/anomaly-alerts/:id/review', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const alertId = req.params.id
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      await c.query(
        `update anomaly_alerts set reviewed=true, reviewed_by=$3, reviewed_at=now()
         where organization_id=$1 and id=$2`, [orgId, alertId, user.id])
      return { reviewed: true }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 7: BI — Stock Snapshots, ABC Curve, Cohort
// ══════════════════════════════════════════════════════════════════════════════

router.post('/bi/stock-snapshot', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into stock_snapshots (organization_id, snapshot_date, product_id, warehouse_id, qty_available, qty_reserved, unit_cost, total_value)
         select sl.organization_id, current_date, sl.product_id, sl.warehouse_id,
                sl.qty_available, sl.qty_reserved, coalesce(p.cost, 0),
                sl.qty_available * coalesce(p.cost, 0)
         from stock_levels sl
         join products p on p.id=sl.product_id and p.organization_id=sl.organization_id
         where sl.organization_id=$1
         on conflict (organization_id, snapshot_date, product_id, warehouse_id) do update
           set qty_available=excluded.qty_available, qty_reserved=excluded.qty_reserved,
               unit_cost=excluded.unit_cost, total_value=excluded.total_value
         returning id`, [orgId])
      return { snapshotDate: new Date().toISOString().slice(0, 10), recordsCreated: r.rowCount ?? 0 }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/bi/stock-snapshots', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const productId = normalizeOpt(req.query.productId)
    const from = normalizeOpt(req.query.from)
    const to = normalizeOpt(req.query.to)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select snapshot_date as "snapshotDate",
                sum(qty_available) as "totalAvailable", sum(qty_reserved) as "totalReserved",
                sum(total_value) as "totalValue"
         from stock_snapshots
         where organization_id=$1
           and ($2='' or product_id::text=$2)
           and ($3='' or snapshot_date >= $3::date)
           and ($4='' or snapshot_date <= $4::date)
         group by snapshot_date order by snapshot_date desc limit 90`,
        [orgId, productId, from, to])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/bi/abc-curve', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const from = normalizeOpt(req.query.from)
    const to = normalizeOpt(req.query.to)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `with product_revenue as (
           select p.id, p.name, p.sku, sum(soi.total_price) as revenue
           from sales_order_items soi
           join products p on p.id=soi.product_id and p.organization_id=soi.organization_id
           join sales_orders so on so.id=soi.sales_order_id and so.organization_id=soi.organization_id
           where soi.organization_id=$1
             and ($2='' or so.created_at::date >= $2::date)
             and ($3='' or so.created_at::date <= $3::date)
           group by p.id, p.name, p.sku
         ),
         ranked as (
           select *, sum(revenue) over () as total_revenue,
                  sum(revenue) over (order by revenue desc) as cumulative_revenue
           from product_revenue
         )
         select id, name, sku, revenue,
                round(revenue / nullif(total_revenue, 0) * 100, 2) as pct,
                round(cumulative_revenue / nullif(total_revenue, 0) * 100, 2) as cumulative_pct,
                case
                  when cumulative_revenue / nullif(total_revenue, 0) <= 0.8 then 'A'
                  when cumulative_revenue / nullif(total_revenue, 0) <= 0.95 then 'B'
                  else 'C'
                end as classification
         from ranked order by revenue desc`,
        [orgId, from, to])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/bi/cohort', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `with first_purchase as (
           select customer_id, date_trunc('month', min(created_at))::date as cohort_month
           from sales_orders where organization_id=$1 group by customer_id
         ),
         activity as (
           select so.customer_id, fp.cohort_month,
                  extract(month from age(date_trunc('month', so.created_at), fp.cohort_month))::int as month_offset
           from sales_orders so
           join first_purchase fp on fp.customer_id=so.customer_id
           where so.organization_id=$1
         )
         select cohort_month as "cohortMonth", month_offset as "monthOffset",
                count(distinct customer_id)::int as customers
         from activity
         group by cohort_month, month_offset
         order by cohort_month desc, month_offset asc`,
        [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/bi/executive-dashboard', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      const { role } = await assertOrgMember(c, orgId, user.id)
      if (role !== 'chefe') throw new Error('Acesso restrito ao perfil Chefe.')
      const [revenue, expenses, overdue, stockValue, openOs, activeContracts] = await Promise.all([
        c.query(`select coalesce(sum(total_amount),0) as v from financial_titles where organization_id=$1 and title_type='receivable' and created_at >= date_trunc('month', current_date)`, [orgId]),
        c.query(`select coalesce(sum(total_amount),0) as v from financial_titles where organization_id=$1 and title_type='payable' and created_at >= date_trunc('month', current_date)`, [orgId]),
        c.query(`select coalesce(sum(fi.amount),0) as v from financial_installments fi join financial_titles ft on ft.id=fi.title_id where fi.organization_id=$1 and fi.status='open' and fi.due_date < current_date`, [orgId]),
        c.query(`select coalesce(sum(sl.qty_available * p.cost),0) as v from stock_levels sl join products p on p.id=sl.product_id where sl.organization_id=$1`, [orgId]),
        c.query(`select count(*)::int as v from service_orders where organization_id=$1 and status in ('open','in_progress')`, [orgId]),
        c.query(`select count(*)::int as v from contracts where organization_id=$1 and status='active'`, [orgId]),
      ])
      return {
        revenueThisMonth: Number(revenue.rows[0]?.v ?? 0),
        expensesThisMonth: Number(expenses.rows[0]?.v ?? 0),
        margin: Number(revenue.rows[0]?.v ?? 0) - Number(expenses.rows[0]?.v ?? 0),
        overdueAmount: Number(overdue.rows[0]?.v ?? 0),
        stockValue: Number(stockValue.rows[0]?.v ?? 0),
        openServiceOrders: Number(openOs.rows[0]?.v ?? 0),
        activeContracts: Number(activeContracts.rows[0]?.v ?? 0),
      }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 10: AUTOMAÇÃO — Notification Rules + Signature Requests
// ══════════════════════════════════════════════════════════════════════════════

router.get('/automation/rules', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, name, trigger_event as "triggerEvent", conditions, actions,
                active, execution_count as "executionCount", last_triggered_at as "lastTriggeredAt",
                created_at as "createdAt"
         from automation_rules where organization_id=$1 order by created_at desc`, [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/automation/rules', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      name: z.string().min(1),
      triggerEvent: z.string().min(1),
      conditions: z.record(z.string(), z.unknown()).optional(),
      actions: z.array(z.record(z.string(), z.unknown())).min(1),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into automation_rules (organization_id, name, trigger_event, conditions, actions)
         values ($1,$2,$3,$4::jsonb,$5::jsonb) returning id`,
        [orgId, data.name, data.triggerEvent, JSON.stringify(data.conditions ?? {}), JSON.stringify(data.actions)])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.patch('/automation/rules/:id/toggle', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update automation_rules set active=not active, updated_at=now()
         where organization_id=$1 and id=$2 returning id, active`, [orgId, req.params.id])
      if ((r.rowCount ?? 0) === 0) throw new Error('Regra não encontrada.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/automation/executions', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const ruleId = normalizeOpt(req.query.ruleId)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select ae.id, ae.rule_id as "ruleId", ar.name as "ruleName",
                ae.trigger_data as "triggerData", ae.result, ae.error_message as "errorMessage",
                ae.executed_at as "executedAt"
         from automation_executions ae
         join automation_rules ar on ar.id=ae.rule_id
         where ae.organization_id=$1 and ($2='' or ae.rule_id::text=$2)
         order by ae.executed_at desc limit $3 offset $4`,
        [orgId, ruleId, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Signature Requests
router.get('/automation/signatures', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, document_type as "documentType", document_id as "documentId",
                provider, signer_name as "signerName", signer_email as "signerEmail",
                status, signed_at as "signedAt", sent_at as "sentAt",
                document_url as "documentUrl", created_at as "createdAt"
         from signature_requests
         where organization_id=$1 and ($2='' or status=$2)
         order by created_at desc`, [orgId, status])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/automation/signatures', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      documentType: z.string().min(1),
      documentId: z.string().uuid(),
      provider: z.enum(['zapsign', 'docusign', 'adobe_sign']).optional(),
      signerName: z.string().min(1),
      signerEmail: z.string().email(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into signature_requests (organization_id, document_type, document_id, provider, signer_name, signer_email, status, sent_at)
         values ($1,$2,$3,$4,$5,$6,'sent',now()) returning id`,
        [orgId, data.documentType, data.documentId, data.provider ?? 'zapsign', data.signerName, data.signerEmail])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 8: COMÉRCIO EXTERIOR
// ══════════════════════════════════════════════════════════════════════════════

router.get('/comex/processes', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select ip.id, ip.reference_number as "referenceNumber", ip.incoterm, ip.currency,
                ip.exchange_rate as "exchangeRate", ip.total_fob as "totalFob",
                ip.total_nationalized as "totalNationalized", ip.status,
                s.name as "supplierName", ip.created_at as "createdAt"
         from import_processes ip
         left join suppliers s on s.id=ip.supplier_id
         where ip.organization_id=$1 and ($2='' or ip.status=$2)
         order by ip.created_at desc limit $3 offset $4`,
        [orgId, status, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/comex/processes', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const idemKey = req.header('idempotency-key')
    const data = z.object({
      supplierId: z.string().uuid().optional(),
      referenceNumber: z.string().optional(),
      incoterm: z.enum(['FOB', 'CIF', 'EXW', 'FCA', 'CFR', 'CPT', 'DDP', 'DAP']).optional(),
      currency: z.string().optional(),
      exchangeRate: z.number().positive().optional(),
      items: z.array(z.object({
        productId: z.string().uuid(),
        quantity: z.number().positive(),
        fobUnitPrice: z.number().positive(),
      })).min(1),
    }).parse(req.body)
    const mutation = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      return runIdempotentMutation({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'comex_process_create', idempotencyKey: idemKey, requestBody: data,
        execute: async () => {
          const totalFob = data.items.reduce((s, i) => s + i.fobUnitPrice * i.quantity, 0)
          const r = await c.query(
            `insert into import_processes (organization_id, supplier_id, reference_number, incoterm, currency, exchange_rate, total_fob)
             values ($1,$2,$3,$4,$5,$6,$7) returning id`,
            [orgId, data.supplierId ?? null, data.referenceNumber ?? null,
             data.incoterm ?? 'FOB', data.currency ?? 'USD', data.exchangeRate ?? null, totalFob])
          const processId = r.rows[0].id as string
          for (const item of data.items) {
            await c.query(
              `insert into import_items (organization_id, process_id, product_id, quantity, fob_unit_price)
               values ($1,$2,$3,$4,$5)`, [orgId, processId, item.productId, item.quantity, item.fobUnitPrice])
          }
          await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
            operation: 'insert', tableName: 'import_processes', recordId: processId,
            newData: { processId, totalFob, itemsCount: data.items.length },
            metadata: { source: 'comex.process.create' } })
          return { status: 201 as const, body: { id: processId, totalFob } }
        }
      })
    })
    res.status(mutation.status).json(mutation.body)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/comex/processes/:id/nationalize', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const processId = req.params.id
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      // Get all costs for apportionment
      const costs = await c.query(
        `select coalesce(sum(amount_brl), 0) as total_costs from import_costs where organization_id=$1 and process_id=$2`,
        [orgId, processId])
      const totalCosts = Number(costs.rows[0]?.total_costs ?? 0)
      // Get items
      const items = await c.query(
        `select id, product_id, quantity, fob_unit_price from import_items where organization_id=$1 and process_id=$2`,
        [orgId, processId])
      const proc = await c.query(
        `select exchange_rate, total_fob from import_processes where organization_id=$1 and id=$2`, [orgId, processId])
      const exchangeRate = Number(proc.rows[0]?.exchange_rate ?? 1)
      const totalFob = Number(proc.rows[0]?.total_fob ?? 0)
      let totalNationalized = 0
      for (const item of items.rows) {
        const fobBrl = Number(item.fob_unit_price) * exchangeRate
        const itemFobTotal = Number(item.fob_unit_price) * Number(item.quantity)
        const costShare = totalFob > 0 ? (itemFobTotal / totalFob) * totalCosts : 0
        const nationalizedUnit = fobBrl + (costShare / Number(item.quantity))
        await c.query(
          `update import_items set nationalized_unit_cost=$3 where organization_id=$1 and id=$2`,
          [orgId, item.id, nationalizedUnit])
        totalNationalized += nationalizedUnit * Number(item.quantity)
      }
      await c.query(
        `update import_processes set total_nationalized=$3, status='cleared', updated_at=now()
         where organization_id=$1 and id=$2`, [orgId, processId, totalNationalized])
      return { totalNationalized, itemsProcessed: items.rows.length }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/comex/processes/:id/costs', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      costType: z.string().min(1),
      description: z.string().optional(),
      amountOriginal: z.number().nonnegative(),
      amountBrl: z.number().nonnegative(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into import_costs (organization_id, process_id, cost_type, description, amount_original, amount_brl)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [orgId, req.params.id, data.costType, data.description ?? null, data.amountOriginal, data.amountBrl])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/comex/containers', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const processId = normalizeOpt(req.query.processId)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, process_id as "processId", container_number as "containerNumber",
                container_type as "containerType", bill_of_lading as "billOfLading",
                shipping_date as "shippingDate", eta_port as "etaPort",
                actual_arrival as "actualArrival", status, created_at as "createdAt"
         from import_containers
         where organization_id=$1 and ($2='' or process_id::text=$2)
         order by created_at desc`, [orgId, processId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/comex/containers', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      processId: z.string().uuid(),
      containerNumber: z.string().optional(),
      containerType: z.enum(['20ft', '40ft', '40hc', 'reefer', 'other']).optional(),
      billOfLading: z.string().optional(),
      shippingDate: z.string().optional(),
      etaPort: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into import_containers (organization_id, process_id, container_number, container_type, bill_of_lading, shipping_date, eta_port)
         values ($1,$2,$3,$4,$5,$6::date,$7::date) returning id`,
        [orgId, data.processId, data.containerNumber ?? null, data.containerType ?? '40ft',
         data.billOfLading ?? null, data.shippingDate ?? null, data.etaPort ?? null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 11: QMS — NCR, Calibration, Documents
// ══════════════════════════════════════════════════════════════════════════════

router.get('/quality/ncr', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, ncr_number as "ncrNumber", ncr_type as "ncrType", title, description,
                root_cause as "rootCause", severity, status, action_plan as "actionPlan",
                responsible_user_id as "responsibleUserId", created_at as "createdAt"
         from nonconformity_reports
         where organization_id=$1 and ($2='' or status=$2)
         order by created_at desc limit $3 offset $4`,
        [orgId, status, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/quality/ncr', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      ncrType: z.enum(['product', 'process', 'supplier', 'customer', 'internal']),
      title: z.string().min(1),
      description: z.string().optional(),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      responsibleUserId: z.string().uuid().optional(),
      productId: z.string().uuid().optional(),
      supplierId: z.string().uuid().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into nonconformity_reports
          (organization_id, ncr_type, title, description, severity, responsible_user_id, product_id, supplier_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, ncr_number as "ncrNumber"`,
        [orgId, data.ncrType, data.title, data.description ?? null, data.severity ?? 'medium',
         data.responsibleUserId ?? null, data.productId ?? null, data.supplierId ?? null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.patch('/quality/ncr/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      status: z.enum(['open', 'analyzing', 'action_plan', 'implementing', 'verifying', 'closed']).optional(),
      rootCause: z.string().optional(),
      actionPlan: z.record(z.string(), z.unknown()).optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update nonconformity_reports set
           status=coalesce($3, status),
           root_cause=coalesce($4, root_cause),
           action_plan=coalesce($5::jsonb, action_plan),
           closed_at=case when $3='closed' then now() else closed_at end,
           updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, req.params.id, data.status ?? null, data.rootCause ?? null,
         data.actionPlan ? JSON.stringify(data.actionPlan) : null])
      if ((r.rowCount ?? 0) === 0) throw new Error('RNC não encontrada.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Calibration
router.get('/quality/calibration', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, name, code, instrument_type as "instrumentType",
                last_calibration as "lastCalibration", next_calibration as "nextCalibration",
                calibration_interval_days as "calibrationIntervalDays",
                status, certificate_url as "certificateUrl", notes
         from calibration_instruments
         where organization_id=$1 and ($2='' or status=$2)
         order by next_calibration asc nulls last`, [orgId, status])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/quality/calibration', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      name: z.string().min(1),
      code: z.string().min(1),
      instrumentType: z.string().optional(),
      calibrationIntervalDays: z.number().int().positive().optional(),
      lastCalibration: z.string().optional(),
    }).parse(req.body)
    const nextCal = data.lastCalibration
      ? new Date(new Date(data.lastCalibration).getTime() + (data.calibrationIntervalDays ?? 365) * 86400000).toISOString().slice(0, 10)
      : null
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into calibration_instruments
          (organization_id, name, code, instrument_type, calibration_interval_days, last_calibration, next_calibration)
         values ($1,$2,$3,$4,$5,$6::date,$7::date) returning id`,
        [orgId, data.name, data.code, data.instrumentType ?? null, data.calibrationIntervalDays ?? 365,
         data.lastCalibration ?? null, nextCal])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Controlled Documents (GED)
router.get('/quality/documents', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const docType = normalizeOpt(req.query.docType)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, title, doc_type as "docType", current_version as "currentVersion",
                status, approved_by as "approvedBy", approved_at as "approvedAt",
                content_url as "contentUrl", notes, created_at as "createdAt"
         from controlled_documents
         where organization_id=$1 and ($2='' or status=$2) and ($3='' or doc_type=$3)
         order by title asc`, [orgId, status, docType])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/quality/documents', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      title: z.string().min(1),
      docType: z.enum(['manual', 'norm', 'pop', 'instruction', 'form', 'policy', 'other']),
      contentUrl: z.string().optional(),
      notes: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into controlled_documents (organization_id, title, doc_type, content_url, notes)
         values ($1,$2,$3,$4,$5) returning id`,
        [orgId, data.title, data.docType, data.contentUrl ?? null, data.notes ?? null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/quality/documents/:id/approve', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update controlled_documents set status='approved', approved_by=$3, approved_at=now(), updated_at=now()
         where organization_id=$1 and id=$2 returning id`, [orgId, req.params.id, user.id])
      if ((r.rowCount ?? 0) === 0) throw new Error('Documento não encontrado.')
      // Create version entry
      const doc = await c.query(`select current_version from controlled_documents where organization_id=$1 and id=$2`, [orgId, req.params.id])
      await c.query(
        `insert into document_versions (organization_id, document_id, version, approved_by, approved_at)
         values ($1,$2,$3,$4,now())`, [orgId, req.params.id, doc.rows[0]?.current_version ?? '1.0', user.id])
      return { approved: true }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 12: TESOURARIA — Loans, Intercompany
// ══════════════════════════════════════════════════════════════════════════════

router.get('/treasury/loans', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, loan_type as "loanType", bank_name as "bankName",
                principal_amount as "principalAmount", interest_rate as "interestRate",
                amortization_system as "amortizationSystem", total_installments as "totalInstallments",
                start_date as "startDate", status, notes, created_at as "createdAt"
         from treasury_loans
         where organization_id=$1 and ($2='' or status=$2)
         order by created_at desc`, [orgId, status])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/treasury/loans', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const idemKey = req.header('idempotency-key')
    const data = z.object({
      loanType: z.enum(['loan', 'investment']),
      bankName: z.string().optional(),
      principalAmount: z.number().positive(),
      interestRate: z.number().positive(),
      amortizationSystem: z.enum(['sac', 'price']).optional(),
      totalInstallments: z.number().int().positive(),
      startDate: z.string(),
      notes: z.string().optional(),
    }).parse(req.body)
    const mutation = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      return runIdempotentMutation({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'treasury_loan_create', idempotencyKey: idemKey, requestBody: data,
        execute: async () => {
          const r = await c.query(
            `insert into treasury_loans
              (organization_id, loan_type, bank_name, principal_amount, interest_rate,
               amortization_system, total_installments, start_date, notes)
             values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9) returning id`,
            [orgId, data.loanType, data.bankName ?? null, data.principalAmount, data.interestRate,
             data.amortizationSystem ?? 'price', data.totalInstallments, data.startDate, data.notes ?? null])
          const loanId = r.rows[0].id as string
          // Generate installments (SAC or PRICE)
          const principal = data.principalAmount
          const monthlyRate = data.interestRate / 100 / 12
          const n = data.totalInstallments
          const system = data.amortizationSystem ?? 'price'
          let balance = principal
          const startDate = new Date(data.startDate)
          for (let i = 1; i <= n; i++) {
            let amort: number, interest: number, total: number
            if (system === 'sac') {
              amort = principal / n
              interest = balance * monthlyRate
              total = amort + interest
            } else {
              // PRICE: PMT = P * r / (1 - (1+r)^-n)
              const pmt = principal * monthlyRate / (1 - Math.pow(1 + monthlyRate, -n))
              interest = balance * monthlyRate
              amort = pmt - interest
              total = pmt
            }
            balance -= amort
            const dueDate = new Date(startDate)
            dueDate.setMonth(dueDate.getMonth() + i)
            await c.query(
              `insert into treasury_loan_installments
                (organization_id, loan_id, installment_number, amortization, interest, total_amount, outstanding_balance, due_date)
               values ($1,$2,$3,$4,$5,$6,$7,$8::date)`,
              [orgId, loanId, i, Number(amort.toFixed(2)), Number(interest.toFixed(2)),
               Number(total.toFixed(2)), Number(Math.max(balance, 0).toFixed(2)),
               dueDate.toISOString().slice(0, 10)])
          }
          await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
            operation: 'insert', tableName: 'treasury_loans', recordId: loanId,
            newData: { loanId, principalAmount: principal, totalInstallments: n, system },
            metadata: { source: 'treasury.loan.create' } })
          return { status: 201 as const, body: { id: loanId, installmentsGenerated: n } }
        }
      })
    })
    res.status(mutation.status).json(mutation.body)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/treasury/loans/:id/installments', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, installment_number as "installmentNumber", amortization, interest,
                total_amount as "totalAmount", outstanding_balance as "outstandingBalance",
                due_date as "dueDate", paid_at as "paidAt", status
         from treasury_loan_installments
         where organization_id=$1 and loan_id=$2
         order by installment_number asc`, [orgId, req.params.id])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Intercompany
router.get('/treasury/intercompany', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select it.id, it.source_organization_id as "sourceOrgId", it.target_organization_id as "targetOrgId",
                it.transfer_type as "transferType", it.amount, it.description, it.status,
                so.name as "sourceOrgName", to2.name as "targetOrgName", it.created_at as "createdAt"
         from intercompany_transfers it
         left join organizations so on so.id=it.source_organization_id
         left join organizations to2 on to2.id=it.target_organization_id
         where it.source_organization_id=$1 or it.target_organization_id=$1
         order by it.created_at desc`, [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/treasury/intercompany', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      targetOrganizationId: z.string().uuid(),
      transferType: z.enum(['financial', 'merchandise']),
      amount: z.number().positive(),
      description: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into intercompany_transfers (source_organization_id, target_organization_id, transfer_type, amount, description)
         values ($1,$2,$3,$4,$5) returning id`,
        [orgId, data.targetOrganizationId, data.transferType, data.amount, data.description ?? null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 15: PSA — Projects, Tasks, Timesheets, Milestones
// ══════════════════════════════════════════════════════════════════════════════

router.get('/projects', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select p.id, p.name, p.status, p.start_date as "startDate",
                p.expected_end_date as "expectedEndDate", p.budget, p.spent,
                c.name as "customerName", p.created_at as "createdAt"
         from projects p
         left join customers c on c.id=p.customer_id
         where p.organization_id=$1 and ($2='' or p.status=$2)
         order by p.created_at desc limit $3 offset $4`,
        [orgId, status, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/projects', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      name: z.string().min(1),
      customerId: z.string().uuid().optional(),
      startDate: z.string().optional(),
      expectedEndDate: z.string().optional(),
      budget: z.number().nonnegative().optional(),
      notes: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into projects (organization_id, name, customer_id, manager_user_id, start_date, expected_end_date, budget, notes)
         values ($1,$2,$3,$4,$5::date,$6::date,$7,$8) returning id`,
        [orgId, data.name, data.customerId ?? null, user.id, data.startDate ?? null,
         data.expectedEndDate ?? null, data.budget ?? null, data.notes ?? null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/projects/:id/tasks', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, name, description, assigned_user_id as "assignedUserId",
                status, start_date as "startDate", end_date as "endDate",
                depends_on_task_id as "dependsOnTaskId", sort_order as "sortOrder",
                estimated_hours as "estimatedHours", created_at as "createdAt"
         from project_tasks
         where organization_id=$1 and project_id=$2
         order by sort_order asc, created_at asc`, [orgId, req.params.id])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/projects/:id/tasks', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      assignedUserId: z.string().uuid().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      dependsOnTaskId: z.string().uuid().optional(),
      estimatedHours: z.number().nonnegative().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const maxOrder = await c.query(
        `select coalesce(max(sort_order), 0) + 1 as next_order from project_tasks
         where organization_id=$1 and project_id=$2`, [orgId, req.params.id])
      const r = await c.query(
        `insert into project_tasks
          (organization_id, project_id, name, description, assigned_user_id, start_date, end_date, depends_on_task_id, sort_order, estimated_hours)
         values ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10) returning id`,
        [orgId, req.params.id, data.name, data.description ?? null, data.assignedUserId ?? null,
         data.startDate ?? null, data.endDate ?? null, data.dependsOnTaskId ?? null,
         maxOrder.rows[0]?.next_order ?? 1, data.estimatedHours ?? null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.patch('/projects/tasks/:taskId/status', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({ status: z.enum(['todo', 'in_progress', 'review', 'done', 'cancelled']) }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update project_tasks set status=$3, updated_at=now() where organization_id=$1 and id=$2 returning id`,
        [orgId, req.params.taskId, data.status])
      if ((r.rowCount ?? 0) === 0) throw new Error('Tarefa não encontrada.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Timesheets
router.post('/projects/:id/timesheets', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      taskId: z.string().uuid().optional(),
      workDate: z.string(),
      hours: z.number().positive(),
      hourlyCost: z.number().nonnegative(),
      notes: z.string().optional(),
    }).parse(req.body)
    const totalCost = data.hours * data.hourlyCost
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into project_timesheets (organization_id, project_id, task_id, user_id, work_date, hours, hourly_cost, total_cost, notes)
         values ($1,$2,$3,$4,$5::date,$6,$7,$8,$9) returning id`,
        [orgId, req.params.id, data.taskId ?? null, user.id, data.workDate, data.hours, data.hourlyCost, totalCost, data.notes ?? null])
      // Update project spent
      await c.query(
        `update projects set spent=spent+$3, updated_at=now() where organization_id=$1 and id=$2`,
        [orgId, req.params.id, totalCost])
      return { id: r.rows[0].id, totalCost }
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/projects/:id/timesheets', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select ts.id, ts.task_id as "taskId", pt.name as "taskName",
                ts.user_id as "userId", ts.work_date as "workDate",
                ts.hours, ts.hourly_cost as "hourlyCost", ts.total_cost as "totalCost",
                ts.notes, ts.created_at as "createdAt"
         from project_timesheets ts
         left join project_tasks pt on pt.id=ts.task_id
         where ts.organization_id=$1 and ts.project_id=$2
         order by ts.work_date desc`, [orgId, req.params.id])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Milestones
router.get('/projects/:id/milestones', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, name, planned_date as "plannedDate", completed_date as "completedDate",
                billing_amount as "billingAmount", billed, financial_title_id as "financialTitleId"
         from project_milestones
         where organization_id=$1 and project_id=$2
         order by planned_date asc nulls last`, [orgId, req.params.id])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/projects/:id/milestones', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      name: z.string().min(1),
      plannedDate: z.string().optional(),
      billingAmount: z.number().nonnegative().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into project_milestones (organization_id, project_id, name, planned_date, billing_amount)
         values ($1,$2,$3,$4::date,$5) returning id`,
        [orgId, req.params.id, data.name, data.plannedDate ?? null, data.billingAmount ?? null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/projects/milestones/:id/complete', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const ms = await c.query(
        `update project_milestones set completed_date=current_date, updated_at=now()
         where organization_id=$1 and id=$2 and completed_date is null
         returning id, billing_amount, project_id`, [orgId, req.params.id])
      if ((ms.rowCount ?? 0) === 0) throw new Error('Milestone não encontrado ou já concluído.')
      const milestone = ms.rows[0]
      // Auto-generate financial title if billing_amount > 0
      if (milestone.billing_amount && Number(milestone.billing_amount) > 0) {
        const title = await c.query(
          `insert into financial_titles (organization_id, title_type, description, total_amount, status)
           values ($1, 'receivable', $2, $3, 'open') returning id`,
          [orgId, `Faturamento milestone: ${req.params.id}`, milestone.billing_amount])
        await c.query(
          `update project_milestones set billed=true, financial_title_id=$3, updated_at=now()
           where organization_id=$1 and id=$2`, [orgId, req.params.id, title.rows[0].id])
      }
      return { completed: true, billed: Number(milestone.billing_amount ?? 0) > 0 }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 14: ESG — Carbon Entries + Compliance Reports
// ══════════════════════════════════════════════════════════════════════════════

router.get('/esg/carbon', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const from = normalizeOpt(req.query.from)
    const to = normalizeOpt(req.query.to)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select entry_type as "entryType",
                sum(co2_kg) as "totalCo2Kg", sum(quantity) as "totalQuantity",
                count(*)::int as entries
         from carbon_entries
         where organization_id=$1
           and ($2='' or period_start >= $2::date)
           and ($3='' or period_end <= $3::date)
         group by entry_type order by "totalCo2Kg" desc`, [orgId, from, to])
      const total = await c.query(
        `select coalesce(sum(co2_kg), 0) as total from carbon_entries
         where organization_id=$1 and ($2='' or period_start >= $2::date) and ($3='' or period_end <= $3::date)`,
        [orgId, from, to])
      return { byType: rows.rows, totalCo2Kg: Number(total.rows[0]?.total ?? 0) }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/esg/carbon', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      entryType: z.enum(['fuel', 'electricity', 'waste', 'transport', 'other']),
      periodStart: z.string(),
      periodEnd: z.string(),
      quantity: z.number().positive(),
      unit: z.string().min(1),
      emissionFactor: z.number().positive(),
      notes: z.string().optional(),
    }).parse(req.body)
    const co2Kg = data.quantity * data.emissionFactor
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into carbon_entries (organization_id, entry_type, period_start, period_end, quantity, unit, emission_factor, co2_kg, notes)
         values ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9) returning id`,
        [orgId, data.entryType, data.periodStart, data.periodEnd, data.quantity, data.unit, data.emissionFactor, co2Kg, data.notes ?? null])
      return { id: r.rows[0].id, co2Kg }
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/esg/carbon/auto-calculate-fleet', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({ periodStart: z.string(), periodEnd: z.string() }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      // Emission factors (kg CO2/liter): gasoline=2.31, ethanol=1.46, diesel=2.68
      const refueling = await c.query(
        `select coalesce(sum(liters), 0) as total_liters,
                coalesce(sum(case when v.fuel_type in ('gasoline','flex') then r.liters * 2.31
                               when v.fuel_type='ethanol' then r.liters * 1.46
                               when v.fuel_type='diesel' then r.liters * 2.68
                               else r.liters * 2.31 end), 0) as co2_kg
         from fleet_refueling r
         join vehicles v on v.id=r.vehicle_id and v.organization_id=r.organization_id
         where r.organization_id=$1
           and r.refueling_date >= $2::date and r.refueling_date <= $3::date`,
        [orgId, data.periodStart, data.periodEnd])
      const totalLiters = Number(refueling.rows[0]?.total_liters ?? 0)
      const co2Kg = Number(refueling.rows[0]?.co2_kg ?? 0)
      if (totalLiters > 0) {
        await c.query(
          `insert into carbon_entries (organization_id, entry_type, period_start, period_end, quantity, unit, emission_factor, co2_kg, notes)
           values ($1,'fuel',$2::date,$3::date,$4,'liters',2.31,$5,'Auto-calculado da frota')
           on conflict do nothing`,
          [orgId, data.periodStart, data.periodEnd, totalLiters, co2Kg])
      }
      return { totalLiters, co2Kg }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Compliance / Anonymous Reports
router.get('/esg/compliance', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, report_type as "reportType", description, is_anonymous as "isAnonymous",
                status, assigned_to as "assignedTo", resolution, resolved_at as "resolvedAt",
                created_at as "createdAt"
         from compliance_reports
         where organization_id=$1 and ($2='' or status=$2)
         order by created_at desc`, [orgId, status])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/esg/compliance', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    // Note: anonymous reports don't require auth
    const authHeader = req.header('authorization')
    let userId: string | null = null
    try {
      const user = await getAuthUser(authHeader)
      userId = user.id
    } catch { /* anonymous is ok */ }
    const data = z.object({
      reportType: z.enum(['complaint', 'observation', 'suggestion', 'irregularity']),
      description: z.string().min(10),
      isAnonymous: z.boolean().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      const r = await c.query(
        `insert into compliance_reports (organization_id, report_type, description, is_anonymous, reporter_user_id)
         values ($1,$2,$3,$4,$5) returning id`,
        [orgId, data.reportType, data.description, data.isAnonymous ?? true,
         (data.isAnonymous ?? true) ? null : userId])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.patch('/esg/compliance/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      status: z.enum(['open', 'investigating', 'resolved', 'dismissed']).optional(),
      resolution: z.string().optional(),
      assignedTo: z.string().uuid().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update compliance_reports set
           status=coalesce($3, status),
           resolution=coalesce($4, resolution),
           assigned_to=coalesce($5, assigned_to),
           resolved_at=case when $3 in ('resolved','dismissed') then now() else resolved_at end,
           updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, req.params.id, data.status ?? null, data.resolution ?? null, data.assignedTo ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Relato não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 16: FRANQUIAS — Groups, Royalties, Catalog, Consolidated DRE
// ══════════════════════════════════════════════════════════════════════════════

router.get('/franchise/groups', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select fg.id, fg.name, fg.parent_organization_id as "parentOrgId",
                (select count(*)::int from franchise_members fm where fm.group_id=fg.id) as "memberCount",
                fg.created_at as "createdAt"
         from franchise_groups fg where fg.parent_organization_id=$1
         order by fg.name`, [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/franchise/groups', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({ name: z.string().min(1) }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into franchise_groups (name, parent_organization_id) values ($1,$2) returning id`,
        [data.name, orgId])
      const groupId = r.rows[0].id as string
      // Auto-add creator org as headquarters
      await c.query(
        `insert into franchise_members (group_id, organization_id, member_type) values ($1,$2,'headquarters')`,
        [groupId, orgId])
      return { id: groupId }
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/franchise/groups/:id/members', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select fm.id, fm.organization_id as "organizationId", o.name as "organizationName",
                fm.member_type as "memberType", fm.active, fm.joined_at as "joinedAt"
         from franchise_members fm
         join organizations o on o.id=fm.organization_id
         where fm.group_id=$1
         order by fm.member_type, o.name`, [req.params.id])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/franchise/groups/:id/members', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      organizationId: z.string().uuid(),
      memberType: z.enum(['branch', 'franchisee']),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into franchise_members (group_id, organization_id, member_type) values ($1,$2,$3) returning id`,
        [req.params.id, data.organizationId, data.memberType])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Royalty Rules
router.get('/franchise/groups/:id/royalty-rules', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, rule_type as "ruleType", percentage, base, active
         from franchise_royalty_rules where group_id=$1 order by rule_type`, [req.params.id])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/franchise/groups/:id/royalty-rules', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      ruleType: z.enum(['royalty', 'marketing_fee', 'technology_fee']),
      percentage: z.number().positive(),
      base: z.enum(['gross_revenue', 'net_revenue']).optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into franchise_royalty_rules (group_id, rule_type, percentage, base)
         values ($1,$2,$3,$4) returning id`,
        [req.params.id, data.ruleType, data.percentage, data.base ?? 'gross_revenue'])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Consolidated DRE (eliminates intercompany)
router.get('/franchise/groups/:id/consolidated-dre', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const from = normalizeOpt(req.query.from)
    const to = normalizeOpt(req.query.to)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select ft.title_type, o.name as "orgName", sum(ft.total_amount) as total
         from financial_titles ft
         join franchise_members fm on fm.organization_id=ft.organization_id and fm.group_id=$1
         join organizations o on o.id=ft.organization_id
         where ($2='' or ft.created_at::date >= $2::date)
           and ($3='' or ft.created_at::date <= $3::date)
         group by ft.title_type, o.name
         order by o.name, ft.title_type`,
        [req.params.id, from, to])
      // Subtract intercompany
      const interco = await c.query(
        `select coalesce(sum(amount), 0) as total
         from intercompany_transfers it
         where it.source_organization_id in (select organization_id from franchise_members where group_id=$1)
           and it.target_organization_id in (select organization_id from franchise_members where group_id=$1)
           and it.status='completed'
           and ($2='' or it.created_at::date >= $2::date) and ($3='' or it.created_at::date <= $3::date)`,
        [req.params.id, from, to])
      return { byOrg: rows.rows, intercompanyElimination: Number(interco.rows[0]?.total ?? 0) }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// Catalog Overrides
router.get('/franchise/groups/:id/catalog', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select fco.id, fco.organization_id as "organizationId", o.name as "orgName",
                fco.product_id as "productId", p.name as "productName",
                fco.regional_price as "regionalPrice", p.price as "globalPrice", fco.active
         from franchise_catalog_overrides fco
         join products p on p.id=fco.product_id
         join organizations o on o.id=fco.organization_id
         where fco.group_id=$1
         order by p.name`, [req.params.id])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/franchise/groups/:id/catalog', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      organizationId: z.string().uuid(),
      productId: z.string().uuid(),
      regionalPrice: z.number().positive(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into franchise_catalog_overrides (group_id, organization_id, product_id, regional_price)
         values ($1,$2,$3,$4)
         on conflict (group_id, organization_id, product_id) do update set regional_price=$4, updated_at=now()
         returning id`, [req.params.id, data.organizationId, data.productId, data.regionalPrice])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// MODULE 13: PORTALS — Portal Access Tokens
// ══════════════════════════════════════════════════════════════════════════════

router.get('/portal/tokens', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const portalType = normalizeOpt(req.query.portalType)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, portal_type as "portalType", entity_id as "entityId", entity_name as "entityName",
                token, permissions, expires_at as "expiresAt", last_used_at as "lastUsedAt",
                active, created_at as "createdAt"
         from portal_access_tokens
         where organization_id=$1 and ($2='' or portal_type=$2)
         order by created_at desc`, [orgId, portalType])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/portal/tokens', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      portalType: z.enum(['supplier', 'customer', 'accountant']),
      entityId: z.string().uuid().optional(),
      entityName: z.string().optional(),
      permissions: z.array(z.string()).optional(),
      expiresInDays: z.number().int().positive().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const token = `portal_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays ?? 90))
      const r = await c.query(
        `insert into portal_access_tokens (organization_id, portal_type, entity_id, entity_name, token, permissions, expires_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7) returning id, token`,
        [orgId, data.portalType, data.entityId ?? null, data.entityName ?? null, token,
         JSON.stringify(data.permissions ?? []), expiresAt.toISOString()])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.patch('/portal/tokens/:id/revoke', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update portal_access_tokens set active=false where organization_id=$1 and id=$2 returning id`,
        [orgId, req.params.id])
      if ((r.rowCount ?? 0) === 0) throw new Error('Token não encontrado.')
      return { revoked: true }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2: PATCH/DELETE ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// ── PATCH Project ───────────────────────────────────────────────────────────
router.patch('/projects/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      name: z.string().optional(),
      status: z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled']).optional(),
      expectedEndDate: z.string().optional(),
      budget: z.number().nonnegative().optional(),
      notes: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update projects set name=coalesce($3, name), status=coalesce($4, status),
           expected_end_date=coalesce($5::date, expected_end_date), budget=coalesce($6, budget),
           notes=coalesce($7, notes),
           actual_end_date=case when $4 in ('completed','cancelled') then current_date else actual_end_date end,
           updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.name ?? null, data.status ?? null, data.expectedEndDate ?? null, data.budget ?? null, data.notes ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Projeto não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── DELETE Task ─────────────────────────────────────────────────────────────
router.delete('/projects/tasks/:taskId', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const taskId = z.string().uuid().parse(req.params.taskId)
    await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(`delete from project_tasks where organization_id=$1 and id=$2`, [orgId, taskId])
      if ((r.rowCount ?? 0) === 0) throw new Error('Tarefa não encontrada.')
    })
    res.json({ deleted: true })
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Comex Process Status ──────────────────────────────────────────────
router.patch('/comex/processes/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      status: z.enum(['draft', 'shipped', 'in_transit', 'customs', 'cleared', 'delivered', 'cancelled']).optional(),
      exchangeRate: z.number().positive().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update import_processes set status=coalesce($3, status), exchange_rate=coalesce($4, exchange_rate), updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.status ?? null, data.exchangeRate ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Processo não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Container Status ──────────────────────────────────────────────────
router.patch('/comex/containers/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      status: z.enum(['pending', 'shipped', 'in_transit', 'at_port', 'cleared', 'delivered']).optional(),
      actualArrival: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update import_containers set status=coalesce($3, status), actual_arrival=coalesce($4::date, actual_arrival), updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.status ?? null, data.actualArrival ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Container não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Calibration Instrument ────────────────────────────────────────────
router.patch('/quality/calibration/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      status: z.enum(['calibrated', 'overdue', 'in_calibration', 'retired']).optional(),
      lastCalibration: z.string().optional(),
      nextCalibration: z.string().optional(),
      certificateUrl: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update calibration_instruments set
           status=coalesce($3, status), last_calibration=coalesce($4::date, last_calibration),
           next_calibration=coalesce($5::date, next_calibration), certificate_url=coalesce($6, certificate_url),
           updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.status ?? null, data.lastCalibration ?? null, data.nextCalibration ?? null, data.certificateUrl ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Instrumento não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Loan Status ───────────────────────────────────────────────────────
router.patch('/treasury/loans/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      status: z.enum(['active', 'paid_off', 'defaulted', 'cancelled']),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update treasury_loans set status=$3, updated_at=now() where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.status])
      if ((r.rowCount ?? 0) === 0) throw new Error('Empréstimo não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Pay Loan Installment ──────────────────────────────────────────────
router.patch('/treasury/loans/installments/:id/pay', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update treasury_loan_installments set status='paid', paid_at=current_date
         where organization_id=$1 and id=$2 and status='open' returning id, loan_id`,
        [orgId, id])
      if ((r.rowCount ?? 0) === 0) throw new Error('Parcela não encontrada ou já paga.')
      // Check if all installments are paid → mark loan as paid_off
      const loanId = r.rows[0].loan_id
      const remaining = await c.query(
        `select count(*)::int as cnt from treasury_loan_installments where organization_id=$1 and loan_id=$2 and status='open'`,
        [orgId, loanId])
      if (Number(remaining.rows[0]?.cnt ?? 0) === 0) {
        await c.query(`update treasury_loans set status='paid_off', updated_at=now() where organization_id=$1 and id=$2`, [orgId, loanId])
      }
      return { paid: true }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Intercompany Transfer (approve/complete) ──────────────────────────
router.patch('/treasury/intercompany/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      status: z.enum(['approved', 'completed', 'cancelled']),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update intercompany_transfers set status=$3, updated_at=now()
         where source_organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.status])
      if ((r.rowCount ?? 0) === 0) throw new Error('Transferência não encontrada.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── DELETE Automation Rule ──────────────────────────────────────────────────
router.delete('/automation/rules/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      await c.query(`delete from automation_executions where organization_id=$1 and rule_id=$2`, [orgId, id])
      const r = await c.query(`delete from automation_rules where organization_id=$1 and id=$2`, [orgId, id])
      if ((r.rowCount ?? 0) === 0) throw new Error('Regra não encontrada.')
    })
    res.json({ deleted: true })
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── DELETE Franchise Member ─────────────────────────────────────────────────
router.delete('/franchise/groups/:groupId/members/:memberId', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const memberId = z.string().uuid().parse(req.params.memberId)
    await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(`delete from franchise_members where id=$1`, [memberId])
      if ((r.rowCount ?? 0) === 0) throw new Error('Membro não encontrado.')
    })
    res.json({ deleted: true })
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── DELETE Franchise Royalty Rule ────────────────────────────────────────────
router.delete('/franchise/groups/:groupId/royalty-rules/:ruleId', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const ruleId = z.string().uuid().parse(req.params.ruleId)
    await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(`delete from franchise_royalty_rules where id=$1`, [ruleId])
      if ((r.rowCount ?? 0) === 0) throw new Error('Regra não encontrada.')
    })
    res.json({ deleted: true })
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Signature Request Status ──────────────────────────────────────────
router.patch('/automation/signatures/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      status: z.enum(['pending', 'sent', 'viewed', 'signed', 'refused', 'expired']),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update signature_requests set status=$3,
           signed_at=case when $3='signed' then now() else signed_at end,
           updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.status])
      if ((r.rowCount ?? 0) === 0) throw new Error('Solicitação não encontrada.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── GET Comex Process Items ─────────────────────────────────────────────────
router.get('/comex/processes/:id/items', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const processId = req.params.id
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select ii.id, ii.product_id as "productId", p.name as "productName",
                ii.quantity, ii.fob_unit_price as "fobUnitPrice",
                ii.nationalized_unit_cost as "nationalizedUnitCost"
         from import_items ii
         join products p on p.id=ii.product_id
         where ii.organization_id=$1 and ii.process_id=$2
         order by p.name`, [orgId, processId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── GET Document Versions ───────────────────────────────────────────────────
router.get('/quality/documents/:id/versions', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const docId = req.params.id
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, version, changes_description as "changesDescription",
                approved_by as "approvedBy", approved_at as "approvedAt",
                content_url as "contentUrl", created_at as "createdAt"
         from document_versions where organization_id=$1 and document_id=$2
         order by created_at desc`, [orgId, docId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

export { router as megaModulesRoutes }
