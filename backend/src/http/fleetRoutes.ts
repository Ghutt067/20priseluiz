import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { recordAuditLog } from './mutationSafety'

const router = Router()

function normalizeOpt(v: unknown) { return typeof v === 'string' ? v.trim() : '' }
function parseLO(q: Record<string, unknown>, def = 30, max = 200) {
  const l = Number.parseInt(typeof q.limit === 'string' ? q.limit : '', 10)
  const o = Number.parseInt(typeof q.offset === 'string' ? q.offset : '', 10)
  return {
    limit: Number.isFinite(l) ? Math.min(Math.max(l, 1), max) : def,
    offset: Number.isFinite(o) ? Math.max(o, 0) : 0,
  }
}

// ── Fleet Vehicles (extended) ───────────────────────────────────────────────
router.get('/fleet/vehicles', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const query = normalizeOpt(req.query.query)
    const like = `%${query}%`
    const status = normalizeOpt(req.query.status)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)

    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const cnt = await c.query<{ total: number }>(
        `select count(*)::int as total from vehicles v
         where v.organization_id=$1
           and ($2='' or v.fleet_status=$2)
           and ($3='' or v.plate ilike $4 or v.brand ilike $4 or v.model ilike $4)`,
        [orgId, status, query, like])
      const rows = await c.query(
        `select v.id, v.plate, v.brand, v.model, v.year, v.color, v.vin,
                v.km_current as "kmCurrent", v.fleet_status as "fleetStatus",
                v.fuel_type as "fuelType", v.tank_liters as "tankLiters",
                v.insurance_expiry as "insuranceExpiry", v.ipva_expiry as "ipvaExpiry",
                c.name as "customerName", v.created_at as "createdAt"
         from vehicles v
         left join customers c on c.id=v.customer_id and c.organization_id=v.organization_id
         where v.organization_id=$1
           and ($2='' or v.fleet_status=$2)
           and ($3='' or v.plate ilike $4 or v.brand ilike $4 or v.model ilike $4)
         order by v.created_at desc limit $5 offset $6`,
        [orgId, status, query, like, limit, offset])
      return { rows: rows.rows, total: Number(cnt.rows[0]?.total ?? 0) }
    })
    res.setHeader('x-total-count', String(result.total))
    res.json(result.rows)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

router.patch('/fleet/vehicles/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const schema = z.object({
      kmCurrent: z.number().nonnegative().optional(),
      fleetStatus: z.enum(['active', 'maintenance', 'inactive', 'sold']).optional(),
      fuelType: z.enum(['gasoline', 'ethanol', 'diesel', 'flex', 'electric', 'hybrid']).optional(),
      tankLiters: z.number().nonnegative().optional(),
      insuranceExpiry: z.string().optional(),
      ipvaExpiry: z.string().optional(),
    })
    const data = schema.parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update vehicles set
           km_current=coalesce($3, km_current),
           fleet_status=coalesce($4, fleet_status),
           fuel_type=coalesce($5, fuel_type),
           tank_liters=coalesce($6, tank_liters),
           insurance_expiry=coalesce($7::date, insurance_expiry),
           ipva_expiry=coalesce($8::date, ipva_expiry),
           updated_at=now()
         where organization_id=$1 and id=$2
         returning id`,
        [orgId, id, data.kmCurrent ?? null, data.fleetStatus ?? null,
         data.fuelType ?? null, data.tankLiters ?? null,
         data.insuranceExpiry ?? null, data.ipvaExpiry ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Veículo não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

// ── Tires ────────────────────────────────────────────────────────────────────
router.get('/fleet/tires', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const vehicleId = normalizeOpt(req.query.vehicleId)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select t.*, v.plate as "vehiclePlate"
         from fleet_tires t
         join vehicles v on v.id=t.vehicle_id and v.organization_id=t.organization_id
         where t.organization_id=$1 and ($2='' or t.vehicle_id::text=$2)
         order by t.created_at desc limit $3 offset $4`,
        [orgId, vehicleId, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

router.post('/fleet/tires', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      vehicleId: z.string().uuid(),
      position: z.string().min(1),
      fireNumber: z.string().optional(),
      treadDepthMm: z.number().nonnegative().optional(),
      kmInstalled: z.number().nonnegative().optional(),
      installedAt: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into fleet_tires (organization_id, vehicle_id, position, fire_number, tread_depth_mm, km_installed, installed_at)
         values ($1,$2,$3,$4,$5,$6,$7::date) returning id`,
        [orgId, data.vehicleId, data.position, data.fireNumber??null, data.treadDepthMm??null, data.kmInstalled??null, data.installedAt??null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

// ── Incidents ────────────────────────────────────────────────────────────────
router.get('/fleet/incidents', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const vehicleId = normalizeOpt(req.query.vehicleId)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select i.*, v.plate as "vehiclePlate"
         from fleet_incidents i
         join vehicles v on v.id=i.vehicle_id and v.organization_id=i.organization_id
         where i.organization_id=$1 and ($2='' or i.vehicle_id::text=$2)
         order by i.incident_date desc limit $3 offset $4`,
        [orgId, vehicleId, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

router.post('/fleet/incidents', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      vehicleId: z.string().uuid(),
      incidentType: z.enum(['accident', 'fine', 'theft', 'vandalism', 'mechanical', 'other']),
      incidentDate: z.string(),
      description: z.string().optional(),
      cost: z.number().nonnegative().optional(),
      insurer: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into fleet_incidents (organization_id, vehicle_id, incident_type, incident_date, description, cost, insurer)
         values ($1,$2,$3,$4::date,$5,$6,$7) returning id`,
        [orgId, data.vehicleId, data.incidentType, data.incidentDate, data.description??null, data.cost??0, data.insurer??null])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

// ── Maintenance Plans ────────────────────────────────────────────────────────
router.get('/fleet/maintenance-plans', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const vehicleId = normalizeOpt(req.query.vehicleId)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select mp.*, v.plate as "vehiclePlate"
         from fleet_maintenance_plans mp
         join vehicles v on v.id=mp.vehicle_id and v.organization_id=mp.organization_id
         where mp.organization_id=$1 and ($2='' or mp.vehicle_id::text=$2)
         order by mp.created_at desc`,
        [orgId, vehicleId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

router.post('/fleet/maintenance-plans', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      vehicleId: z.string().uuid(),
      name: z.string().min(1),
      planType: z.enum(['km', 'time', 'both']),
      intervalKm: z.number().nonnegative().optional(),
      intervalDays: z.number().int().positive().optional(),
      lastKm: z.number().nonnegative().optional(),
      lastDate: z.string().optional(),
      autoGenerateOs: z.boolean().optional(),
    }).parse(req.body)
    const nextKm = data.lastKm && data.intervalKm ? data.lastKm + data.intervalKm : null
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into fleet_maintenance_plans
          (organization_id, vehicle_id, name, plan_type, interval_km, interval_days, last_km, last_date, next_km, auto_generate_os)
         values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10) returning id`,
        [orgId, data.vehicleId, data.name, data.planType, data.intervalKm??null, data.intervalDays??null,
         data.lastKm??null, data.lastDate??null, nextKm, data.autoGenerateOs??true])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

// ── Refueling ────────────────────────────────────────────────────────────────
router.get('/fleet/refueling', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const vehicleId = normalizeOpt(req.query.vehicleId)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select r.*, v.plate as "vehiclePlate"
         from fleet_refueling r
         join vehicles v on v.id=r.vehicle_id and v.organization_id=r.organization_id
         where r.organization_id=$1 and ($2='' or r.vehicle_id::text=$2)
         order by r.refueling_date desc limit $3 offset $4`,
        [orgId, vehicleId, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

router.post('/fleet/refueling', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      vehicleId: z.string().uuid(),
      refuelingDate: z.string(),
      kmCurrent: z.number().nonnegative(),
      liters: z.number().positive(),
      totalCost: z.number().nonnegative(),
      fuelType: z.string().optional(),
      station: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      // Calculate km/l from previous refueling
      const prev = await c.query(
        `select km_current from fleet_refueling
         where organization_id=$1 and vehicle_id=$2
         order by refueling_date desc, created_at desc limit 1`,
        [orgId, data.vehicleId])
      const prevKm = prev.rows[0]?.km_current ? Number(prev.rows[0].km_current) : null
      const kmPerLiter = prevKm !== null && data.kmCurrent > prevKm
        ? Number(((data.kmCurrent - prevKm) / data.liters).toFixed(2))
        : null
      const r = await c.query(
        `insert into fleet_refueling
          (organization_id, vehicle_id, refueling_date, km_current, liters, total_cost, fuel_type, km_per_liter, station)
         values ($1,$2,$3::date,$4,$5,$6,$7,$8,$9) returning id, km_per_liter as "kmPerLiter"`,
        [orgId, data.vehicleId, data.refuelingDate, data.kmCurrent, data.liters, data.totalCost,
         data.fuelType??null, kmPerLiter, data.station??null])
      // Update vehicle km
      await c.query(`update vehicles set km_current=$3, updated_at=now() where organization_id=$1 and id=$2`,
        [orgId, data.vehicleId, data.kmCurrent])
      return r.rows[0]
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

// ── Maintenance alerts ───────────────────────────────────────────────────────
router.get('/fleet/maintenance-alerts', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select mp.id, mp.name, mp.plan_type as "planType",
                mp.next_km as "nextKm", mp.next_date as "nextDate",
                v.id as "vehicleId", v.plate, v.km_current as "kmCurrent",
                case
                  when mp.next_date is not null and mp.next_date <= current_date then 'overdue_time'
                  when mp.next_km is not null and v.km_current >= mp.next_km then 'overdue_km'
                  when mp.next_date is not null and mp.next_date <= current_date + interval '7 days' then 'soon_time'
                  when mp.next_km is not null and v.km_current >= mp.next_km - 500 then 'soon_km'
                  else 'ok'
                end as alert_level
         from fleet_maintenance_plans mp
         join vehicles v on v.id=mp.vehicle_id and v.organization_id=mp.organization_id
         where mp.organization_id=$1 and mp.active=true
         having case
                  when mp.next_date is not null and mp.next_date <= current_date + interval '7 days' then true
                  when mp.next_km is not null and v.km_current >= mp.next_km - 500 then true
                  else false
                end = true
         order by mp.next_date asc nulls last`,
        [orgId])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro inesperado.' }) }
})

// ── PATCH/DELETE for Tires ───────────────────────────────────────────────────
router.patch('/fleet/tires/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      treadDepthMm: z.number().nonnegative().optional(),
      status: z.enum(['active', 'worn', 'removed', 'retreaded']).optional(),
      removedAt: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update fleet_tires set
           tread_depth_mm=coalesce($3, tread_depth_mm),
           status=coalesce($4, status),
           removed_at=coalesce($5::date, removed_at),
           updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.treadDepthMm ?? null, data.status ?? null, data.removedAt ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Pneu não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.delete('/fleet/tires/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(`delete from fleet_tires where organization_id=$1 and id=$2`, [orgId, id])
      if ((r.rowCount ?? 0) === 0) throw new Error('Pneu não encontrado.')
    })
    res.json({ deleted: true })
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH for Incidents ─────────────────────────────────────────────────────
router.patch('/fleet/incidents/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
      cost: z.number().nonnegative().optional(),
      insuranceClaim: z.string().optional(),
      insurer: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update fleet_incidents set
           status=coalesce($3, status), cost=coalesce($4, cost),
           insurance_claim=coalesce($5, insurance_claim), insurer=coalesce($6, insurer),
           updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.status ?? null, data.cost ?? null, data.insuranceClaim ?? null, data.insurer ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Sinistro não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH/DELETE for Maintenance Plans ───────────────────────────────────────
router.patch('/fleet/maintenance-plans/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({
      active: z.boolean().optional(),
      lastKm: z.number().nonnegative().optional(),
      lastDate: z.string().optional(),
      nextKm: z.number().nonnegative().optional(),
      nextDate: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update fleet_maintenance_plans set
           active=coalesce($3, active), last_km=coalesce($4, last_km),
           last_date=coalesce($5::date, last_date), next_km=coalesce($6, next_km),
           next_date=coalesce($7::date, next_date), updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.active ?? null, data.lastKm ?? null, data.lastDate ?? null, data.nextKm ?? null, data.nextDate ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Plano não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.delete('/fleet/maintenance-plans/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(`delete from fleet_maintenance_plans where organization_id=$1 and id=$2`, [orgId, id])
      if ((r.rowCount ?? 0) === 0) throw new Error('Plano não encontrado.')
    })
    res.json({ deleted: true })
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

export { router as fleetRoutes }
