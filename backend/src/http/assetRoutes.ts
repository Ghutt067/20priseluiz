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

// ── Fixed Assets CRUD ────────────────────────────────────────────────────────
router.get('/assets', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const query = normalizeOpt(req.query.query)
    const like = `%${query}%`
    const status = normalizeOpt(req.query.status)
    const category = normalizeOpt(req.query.category)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const cnt = await c.query<{ total: number }>(
        `select count(*)::int as total from fixed_assets
         where organization_id=$1 and ($2='' or status=$2) and ($3='' or category=$3)
           and ($4='' or name ilike $5 or asset_number ilike $5)`,
        [orgId, status, category, query, like])
      const rows = await c.query(
        `select id, name, category, asset_number as "assetNumber",
                acquisition_value as "acquisitionValue", acquisition_date as "acquisitionDate",
                useful_life_months as "usefulLifeMonths", depreciation_method as "depreciationMethod",
                residual_value as "residualValue", current_value as "currentValue",
                responsible_user_id as "responsibleUserId", location_description as "locationDescription",
                status, notes, created_at as "createdAt"
         from fixed_assets
         where organization_id=$1 and ($2='' or status=$2) and ($3='' or category=$3)
           and ($4='' or name ilike $5 or asset_number ilike $5)
         order by created_at desc limit $6 offset $7`,
        [orgId, status, category, query, like, limit, offset])
      return { rows: rows.rows, total: Number(cnt.rows[0]?.total ?? 0) }
    })
    res.setHeader('x-total-count', String(result.total))
    res.json(result.rows)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/assets', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const idemKey = req.header('idempotency-key')
    const data = z.object({
      name: z.string().min(1),
      category: z.string().min(1),
      assetNumber: z.string().optional(),
      acquisitionValue: z.number().positive(),
      acquisitionDate: z.string(),
      usefulLifeMonths: z.number().int().positive().optional(),
      depreciationMethod: z.enum(['linear', 'accelerated']).optional(),
      residualValue: z.number().nonnegative().optional(),
      responsibleUserId: z.string().uuid().optional(),
      locationDescription: z.string().optional(),
      notes: z.string().optional(),
    }).parse(req.body)
    const mutation = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      return runIdempotentMutation({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'asset_create', idempotencyKey: idemKey, requestBody: data,
        execute: async () => {
          const r = await c.query(
            `insert into fixed_assets
              (organization_id, name, category, asset_number, acquisition_value, acquisition_date,
               useful_life_months, depreciation_method, residual_value, current_value,
               responsible_user_id, location_description, notes)
             values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$5,$10,$11,$12) returning id`,
            [orgId, data.name, data.category, data.assetNumber??null, data.acquisitionValue,
             data.acquisitionDate, data.usefulLifeMonths??60, data.depreciationMethod??'linear',
             data.residualValue??0, data.responsibleUserId??null, data.locationDescription??null,
             data.notes??null])
          const assetId = r.rows[0].id as string
          await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
            operation: 'insert', tableName: 'fixed_assets', recordId: assetId,
            newData: { assetId, ...data }, metadata: { source: 'assets.create' } })
          return { status: 201 as const, body: { id: assetId } }
        }
      })
    })
    res.status(mutation.status).json(mutation.body)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Depreciation Calculation ─────────────────────────────────────────────────
router.post('/assets/calculate-depreciation', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      referenceMonth: z.string(), // YYYY-MM-01
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const assets = await c.query(
        `select id, acquisition_value, residual_value, useful_life_months, acquisition_date, depreciation_method
         from fixed_assets where organization_id=$1 and status='active'`, [orgId])
      let calculated = 0
      for (const asset of assets.rows) {
        const acqValue = Number(asset.acquisition_value)
        const residual = Number(asset.residual_value)
        const life = Number(asset.useful_life_months)
        const monthlyDep = (acqValue - residual) / life
        // Check if already calculated for this month
        const existing = await c.query(
          `select id from asset_depreciations where organization_id=$1 and asset_id=$2 and reference_month=$3::date`,
          [orgId, asset.id, data.referenceMonth])
        if ((existing.rowCount ?? 0) > 0) continue
        // Get accumulated depreciation
        const accum = await c.query(
          `select coalesce(sum(depreciation_value), 0) as total from asset_depreciations
           where organization_id=$1 and asset_id=$2`, [orgId, asset.id])
        const accumulated = Number(accum.rows[0]?.total ?? 0) + monthlyDep
        const bookValue = acqValue - accumulated
        if (bookValue < residual) continue // fully depreciated
        await c.query(
          `insert into asset_depreciations (organization_id, asset_id, reference_month, depreciation_value, accumulated_depreciation, book_value)
           values ($1,$2,$3::date,$4,$5,$6)`,
          [orgId, asset.id, data.referenceMonth, monthlyDep, accumulated, Math.max(bookValue, residual)])
        await c.query(`update fixed_assets set current_value=$3, updated_at=now() where organization_id=$1 and id=$2`,
          [orgId, asset.id, Math.max(bookValue, residual)])
        calculated++
      }
      return { calculated, referenceMonth: data.referenceMonth }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/assets/:id/depreciations', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const assetId = req.params.id
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select id, reference_month as "referenceMonth", depreciation_value as "depreciationValue",
                accumulated_depreciation as "accumulatedDepreciation", book_value as "bookValue",
                created_at as "createdAt"
         from asset_depreciations where organization_id=$1 and asset_id=$2
         order by reference_month desc`, [orgId, assetId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Asset Transfers ──────────────────────────────────────────────────────────
router.post('/assets/:id/transfer', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const assetId = req.params.id
    const data = z.object({
      toUserId: z.string().uuid(),
      reason: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const asset = await c.query(
        `select id, responsible_user_id from fixed_assets where organization_id=$1 and id=$2 for update`,
        [orgId, assetId])
      if ((asset.rowCount ?? 0) === 0) throw new Error('Ativo não encontrado.')
      const fromUserId = asset.rows[0].responsible_user_id
      await c.query(
        `insert into asset_transfers (organization_id, asset_id, from_user_id, to_user_id, reason)
         values ($1,$2,$3,$4,$5)`,
        [orgId, assetId, fromUserId, data.toUserId, data.reason??null])
      await c.query(`update fixed_assets set responsible_user_id=$3, updated_at=now() where organization_id=$1 and id=$2`,
        [orgId, assetId, data.toUserId])
      await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'update', tableName: 'fixed_assets', recordId: assetId,
        newData: { fromUserId, toUserId: data.toUserId, reason: data.reason },
        metadata: { source: 'assets.transfer' } })
      return { transferred: true }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.get('/assets/:id/transfers', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const assetId = req.params.id
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select at.id, at.from_user_id as "fromUserId", at.to_user_id as "toUserId",
                at.transfer_date as "transferDate", at.reason, at.created_at as "createdAt"
         from asset_transfers at where at.organization_id=$1 and at.asset_id=$2
         order by at.created_at desc`, [orgId, assetId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH Asset (edit fields) ───────────────────────────────────────────────
router.patch('/assets/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      name: z.string().optional(),
      category: z.string().optional(),
      status: z.enum(['active', 'maintenance', 'disposed', 'transferred']).optional(),
      locationDescription: z.string().optional(),
      notes: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update fixed_assets set
           name=coalesce($3, name), category=coalesce($4, category),
           status=coalesce($5, status), location_description=coalesce($6, location_description),
           notes=coalesce($7, notes),
           disposed_at=case when $5='disposed' then current_date else disposed_at end,
           updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.name ?? null, data.category ?? null, data.status ?? null,
         data.locationDescription ?? null, data.notes ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Ativo não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

export { router as assetRoutes }
