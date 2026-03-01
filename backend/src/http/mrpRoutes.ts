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

// ── Bill of Materials ────────────────────────────────────────────────────────
router.get('/mrp/bom', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const query = normalizeOpt(req.query.query)
    const like = `%${query}%`
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const cnt = await c.query<{ total: number }>(
        `select count(*)::int as total from bill_of_materials b
         join products p on p.id=b.product_id and p.organization_id=b.organization_id
         where b.organization_id=$1 and ($2='' or b.name ilike $3 or p.name ilike $3)`,
        [orgId, query, like])
      const rows = await c.query(
        `select b.id, b.name, b.version, b.active, b.product_id as "productId",
                p.name as "productName", p.sku as "productSku", b.created_at as "createdAt"
         from bill_of_materials b
         join products p on p.id=b.product_id and p.organization_id=b.organization_id
         where b.organization_id=$1 and ($2='' or b.name ilike $3 or p.name ilike $3)
         order by b.created_at desc limit $4 offset $5`,
        [orgId, query, like, limit, offset])
      return { rows: rows.rows, total: Number(cnt.rows[0]?.total ?? 0) }
    })
    res.setHeader('x-total-count', String(result.total))
    res.json(result.rows)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/mrp/bom/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const bomId = req.params.id
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const bom = await c.query(
        `select b.id, b.name, b.version, b.active, b.product_id as "productId",
                p.name as "productName"
         from bill_of_materials b
         join products p on p.id=b.product_id
         where b.organization_id=$1 and b.id=$2 limit 1`, [orgId, bomId])
      if ((bom.rowCount ?? 0) === 0) throw new Error('Ficha técnica não encontrada.')
      const items = await c.query(
        `select bi.id, bi.component_product_id as "componentProductId",
                p.name as "componentName", p.sku as "componentSku",
                bi.qty_per_unit as "qtyPerUnit", bi.unit_of_measure as "unitOfMeasure",
                bi.scrap_pct as "scrapPct"
         from bom_items bi
         join products p on p.id=bi.component_product_id
         where bi.organization_id=$1 and bi.bom_id=$2
         order by bi.id asc`, [orgId, bomId])
      return { bom: bom.rows[0], items: items.rows }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/mrp/bom', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const idemKey = req.header('idempotency-key')
    const data = z.object({
      productId: z.string().uuid(),
      name: z.string().min(1),
      version: z.string().optional(),
      items: z.array(z.object({
        componentProductId: z.string().uuid(),
        qtyPerUnit: z.number().positive(),
        unitOfMeasure: z.string().optional(),
        scrapPct: z.number().nonnegative().optional(),
      })).min(1, 'BOM precisa de ao menos um componente.'),
    }).parse(req.body)
    const mutation = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      return runIdempotentMutation({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'mrp_bom_create', idempotencyKey: idemKey, requestBody: data,
        execute: async () => {
          const r = await c.query(
            `insert into bill_of_materials (organization_id, product_id, name, version)
             values ($1,$2,$3,$4) returning id`,
            [orgId, data.productId, data.name, data.version ?? '1.0'])
          const bomId = r.rows[0].id as string
          for (const item of data.items) {
            await c.query(
              `insert into bom_items (organization_id, bom_id, component_product_id, qty_per_unit, unit_of_measure, scrap_pct)
               values ($1,$2,$3,$4,$5,$6)`,
              [orgId, bomId, item.componentProductId, item.qtyPerUnit, item.unitOfMeasure ?? 'un', item.scrapPct ?? 0])
          }
          await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
            operation: 'insert', tableName: 'bill_of_materials', recordId: bomId,
            newData: { bomId, productId: data.productId, itemsCount: data.items.length },
            metadata: { source: 'mrp.bom.create' } })
          return { status: 201 as const, body: { id: bomId } }
        }
      })
    })
    res.status(mutation.status).json(mutation.body)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Material Explosion (MRP) ─────────────────────────────────────────────────
router.get('/mrp/explosion', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      // Calculate net requirement: planned qty × bom qty - free stock
      const rows = await c.query(
        `select bi.component_product_id as "componentProductId",
                p.name as "componentName", p.sku as "componentSku",
                sum(bi.qty_per_unit * po.qty_planned * (1 + bi.scrap_pct/100)) as "grossRequired",
                coalesce(sum(distinct sl.qty_available - sl.qty_reserved), 0) as "freeStock",
                greatest(sum(bi.qty_per_unit * po.qty_planned * (1 + bi.scrap_pct/100))
                  - coalesce(max(sl.qty_available - sl.qty_reserved), 0), 0) as "netRequired"
         from production_orders po
         join bill_of_materials b on b.id=po.bom_id and b.organization_id=po.organization_id
         join bom_items bi on bi.bom_id=b.id and bi.organization_id=b.organization_id
         join products p on p.id=bi.component_product_id and p.organization_id=bi.organization_id
         left join stock_levels sl on sl.organization_id=bi.organization_id and sl.product_id=bi.component_product_id
         where po.organization_id=$1 and po.status in ('planned','released')
         group by bi.component_product_id, p.name, p.sku
         having greatest(sum(bi.qty_per_unit * po.qty_planned * (1 + bi.scrap_pct/100))
           - coalesce(max(sl.qty_available - sl.qty_reserved), 0), 0) > 0
         order by "netRequired" desc`,
        [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Production Orders ────────────────────────────────────────────────────────
router.get('/mrp/production-orders', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const cnt = await c.query<{ total: number }>(
        `select count(*)::int as total from production_orders
         where organization_id=$1 and ($2='' or status=$2)`, [orgId, status])
      const rows = await c.query(
        `select po.id, po.status, po.qty_planned as "qtyPlanned", po.qty_produced as "qtyProduced",
                po.start_date as "startDate", po.end_date as "endDate",
                p.name as "productName", b.name as "bomName",
                w.name as "warehouseName", po.created_at as "createdAt"
         from production_orders po
         join products p on p.id=po.product_id
         join bill_of_materials b on b.id=po.bom_id
         join warehouses w on w.id=po.warehouse_id
         where po.organization_id=$1 and ($2='' or po.status=$2)
         order by po.created_at desc limit $3 offset $4`,
        [orgId, status, limit, offset])
      return { rows: rows.rows, total: Number(cnt.rows[0]?.total ?? 0) }
    })
    res.setHeader('x-total-count', String(result.total))
    res.json(result.rows)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/mrp/production-orders', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const idemKey = req.header('idempotency-key')
    const data = z.object({
      bomId: z.string().uuid(),
      productId: z.string().uuid(),
      warehouseId: z.string().uuid(),
      qtyPlanned: z.number().positive(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      notes: z.string().optional(),
    }).parse(req.body)
    const mutation = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      return runIdempotentMutation({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'mrp_production_order_create', idempotencyKey: idemKey, requestBody: data,
        execute: async () => {
          // Validate BOM exists
          const bomCheck = await c.query(`select id from bill_of_materials where organization_id=$1 and id=$2 limit 1`, [orgId, data.bomId])
          if ((bomCheck.rowCount ?? 0) === 0) throw new Error('Ficha técnica não encontrada.')
          // Get BOM items for explosion
          const bomItems = await c.query(
            `select component_product_id, qty_per_unit, scrap_pct from bom_items where organization_id=$1 and bom_id=$2`,
            [orgId, data.bomId])
          const r = await c.query(
            `insert into production_orders (organization_id, bom_id, product_id, warehouse_id, qty_planned, start_date, end_date, notes)
             values ($1,$2,$3,$4,$5,$6::date,$7::date,$8) returning id`,
            [orgId, data.bomId, data.productId, data.warehouseId, data.qtyPlanned,
             data.startDate??null, data.endDate??null, data.notes??null])
          const orderId = r.rows[0].id as string
          // Create production order items from BOM
          for (const item of bomItems.rows) {
            const qtyReq = data.qtyPlanned * Number(item.qty_per_unit) * (1 + Number(item.scrap_pct)/100)
            await c.query(
              `insert into production_order_items (organization_id, production_order_id, component_product_id, qty_required)
               values ($1,$2,$3,$4)`, [orgId, orderId, item.component_product_id, qtyReq])
          }
          await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
            operation: 'insert', tableName: 'production_orders', recordId: orderId,
            newData: { orderId, qtyPlanned: data.qtyPlanned, bomId: data.bomId },
            metadata: { source: 'mrp.production.create' } })
          return { status: 201 as const, body: { id: orderId } }
        }
      })
    })
    res.status(mutation.status).json(mutation.body)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Production Reporting (apontamento) ───────────────────────────────────────
router.post('/mrp/production-orders/:id/report', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const orderId = req.params.id
    const data = z.object({
      qtyProduced: z.number().nonnegative(),
      consumptions: z.array(z.object({
        componentProductId: z.string().uuid(),
        qtyConsumed: z.number().nonnegative(),
      })).optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const order = await c.query(
        `select id, status, qty_produced from production_orders where organization_id=$1 and id=$2 for update`,
        [orgId, orderId])
      if ((order.rowCount ?? 0) === 0) throw new Error('Ordem de produção não encontrada.')
      const current = order.rows[0]
      if (current.status === 'completed' || current.status === 'cancelled') throw new Error('Ordem já finalizada.')
      const newQty = Number(current.qty_produced) + data.qtyProduced
      await c.query(
        `update production_orders set qty_produced=$3, status=case when $3>=qty_planned then 'completed' else 'in_progress' end, updated_at=now()
         where organization_id=$1 and id=$2`, [orgId, orderId, newQty])
      if (data.consumptions) {
        for (const cons of data.consumptions) {
          await c.query(
            `update production_order_items set qty_consumed=qty_consumed+$4, updated_at=now()
             where organization_id=$1 and production_order_id=$2 and component_product_id=$3`,
            [orgId, orderId, cons.componentProductId, cons.qtyConsumed])
        }
      }
      return { qtyProduced: newQty }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Production Costs ─────────────────────────────────────────────────────────
router.post('/mrp/production-orders/:id/costs', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const orderId = req.params.id
    const data = z.object({
      costType: z.enum(['material', 'labor', 'fixed', 'variable', 'other']),
      description: z.string().optional(),
      amount: z.number().positive(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into production_costs (organization_id, production_order_id, cost_type, description, amount)
         values ($1,$2,$3,$4,$5) returning id`,
        [orgId, orderId, data.costType, data.description??null, data.amount])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/mrp/production-orders/:id/costs', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const orderId = req.params.id
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const costs = await c.query(
        `select pc.id, pc.cost_type as "costType", pc.description, pc.amount, pc.created_at as "createdAt"
         from production_costs pc where pc.organization_id=$1 and pc.production_order_id=$2
         order by pc.created_at asc`, [orgId, orderId])
      const total = await c.query(
        `select coalesce(sum(amount),0) as total from production_costs
         where organization_id=$1 and production_order_id=$2`, [orgId, orderId])
      const qtyProduced = await c.query(
        `select qty_produced from production_orders where organization_id=$1 and id=$2`, [orgId, orderId])
      const qty = Number(qtyProduced.rows[0]?.qty_produced ?? 0)
      const totalCost = Number(total.rows[0]?.total ?? 0)
      return { items: costs.rows, totalCost, unitCost: qty > 0 ? Number((totalCost / qty).toFixed(4)) : 0 }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Machine Stops ────────────────────────────────────────────────────────────
router.post('/mrp/machine-stops', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      productionOrderId: z.string().uuid().optional(),
      machineName: z.string().min(1),
      startedAt: z.string(),
      endedAt: z.string().optional(),
      reason: z.string().optional(),
    }).parse(req.body)
    const start = new Date(data.startedAt)
    const end = data.endedAt ? new Date(data.endedAt) : null
    const duration = end ? Math.round((end.getTime() - start.getTime()) / 60000) : null
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into machine_stops (organization_id, production_order_id, machine_name, started_at, ended_at, duration_minutes, reason)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [orgId, data.productionOrderId??null, data.machineName, data.startedAt, data.endedAt??null, duration, data.reason??null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Production Waste ─────────────────────────────────────────────────────────
router.post('/mrp/waste', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      productionOrderId: z.string().uuid(),
      componentProductId: z.string().uuid(),
      qtyWasted: z.number().positive(),
      reason: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into production_waste (organization_id, production_order_id, component_product_id, qty_wasted, reason)
         values ($1,$2,$3,$4,$5) returning id`,
        [orgId, data.productionOrderId, data.componentProductId, data.qtyWasted, data.reason??null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH BOM (toggle active, update version) ──────────────────────────────
router.patch('/mrp/bom/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      active: z.boolean().optional(),
      version: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update bill_of_materials set active=coalesce($3, active), version=coalesce($4, version), updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.active ?? null, data.version ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('BOM não encontrada.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Production Order (change status, dates) ──────────────────────────
router.patch('/mrp/production-orders/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      status: z.enum(['planned', 'released', 'in_progress', 'completed', 'cancelled']).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      notes: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update production_orders set
           status=coalesce($3, status), start_date=coalesce($4::date, start_date),
           end_date=coalesce($5::date, end_date), notes=coalesce($6, notes), updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.status ?? null, data.startDate ?? null, data.endDate ?? null, data.notes ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Ordem não encontrada.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── GET machine stops ───────────────────────────────────────────────────────
router.get('/mrp/machine-stops', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const orderId = typeof req.query.productionOrderId === 'string' ? req.query.productionOrderId.trim() : ''
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, production_order_id as "productionOrderId", machine_name as "machineName",
                started_at as "startedAt", ended_at as "endedAt", duration_minutes as "durationMinutes",
                reason, created_at as "createdAt"
         from machine_stops where organization_id=$1 and ($2='' or production_order_id::text=$2)
         order by started_at desc limit $3 offset $4`,
        [orgId, orderId, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── GET waste ───────────────────────────────────────────────────────────────
router.get('/mrp/waste', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const orderId = typeof req.query.productionOrderId === 'string' ? req.query.productionOrderId.trim() : ''
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select w.id, w.production_order_id as "productionOrderId",
                w.component_product_id as "componentProductId", p.name as "componentName",
                w.qty_wasted as "qtyWasted", w.reason, w.created_at as "createdAt"
         from production_waste w
         join products p on p.id=w.component_product_id
         where w.organization_id=$1 and ($2='' or w.production_order_id::text=$2)
         order by w.created_at desc`,
        [orgId, orderId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

export { router as mrpRoutes }
