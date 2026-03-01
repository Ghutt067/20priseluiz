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

// ── Warehouse Locations ──────────────────────────────────────────────────────
router.get('/wms/locations', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const warehouseId = normalizeOpt(req.query.warehouseId)
    const query = normalizeOpt(req.query.query)
    const like = `%${query}%`
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const cnt = await c.query<{ total: number }>(
        `select count(*)::int as total from warehouse_locations wl
         where wl.organization_id=$1 and ($2='' or wl.warehouse_id::text=$2)
           and ($3='' or wl.code ilike $4 or wl.aisle ilike $4)`,
        [orgId, warehouseId, query, like])
      const rows = await c.query(
        `select wl.id, wl.warehouse_id as "warehouseId", w.name as "warehouseName",
                wl.aisle, wl.shelf, wl.level, wl.code, wl.active, wl.created_at as "createdAt"
         from warehouse_locations wl
         join warehouses w on w.id=wl.warehouse_id and w.organization_id=wl.organization_id
         where wl.organization_id=$1 and ($2='' or wl.warehouse_id::text=$2)
           and ($3='' or wl.code ilike $4 or wl.aisle ilike $4)
         order by wl.code asc limit $5 offset $6`,
        [orgId, warehouseId, query, like, limit, offset])
      return { rows: rows.rows, total: Number(cnt.rows[0]?.total ?? 0) }
    })
    res.setHeader('x-total-count', String(result.total))
    res.json(result.rows)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/wms/locations', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const idemKey = req.header('idempotency-key')
    const data = z.object({
      warehouseId: z.string().uuid(),
      aisle: z.string().min(1),
      shelf: z.string().min(1),
      level: z.string().min(1),
      code: z.string().min(1),
    }).parse(req.body)
    const mutation = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      return runIdempotentMutation({ client: c, organizationId: orgId, actorUserId: user.id,
        operation: 'wms_location_create', idempotencyKey: idemKey, requestBody: data,
        execute: async () => {
          const r = await c.query(
            `insert into warehouse_locations (organization_id, warehouse_id, aisle, shelf, level, code)
             values ($1,$2,$3,$4,$5,$6) returning id`,
            [orgId, data.warehouseId, data.aisle, data.shelf, data.level, data.code])
          await recordAuditLog({ client: c, organizationId: orgId, actorUserId: user.id,
            operation: 'insert', tableName: 'warehouse_locations', recordId: r.rows[0].id as string,
            newData: data, metadata: { source: 'wms.location.create' } })
          return { status: 201 as const, body: { id: r.rows[0].id } }
        }
      })
    })
    res.status(mutation.status).json(mutation.body)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Pick Lists ───────────────────────────────────────────────────────────────
router.get('/wms/pick-lists', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const status = normalizeOpt(req.query.status)
    const { limit, offset } = parseLO(req.query as Record<string, unknown>)
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const rows = await c.query(
        `select pl.id, pl.status, pl.shipment_id as "shipmentId", pl.sales_order_id as "salesOrderId",
                pl.picked_at as "pickedAt", pl.packed_at as "packedAt", pl.created_at as "createdAt",
                (select count(*)::int from pick_list_items pli where pli.pick_list_id=pl.id) as "itemCount"
         from pick_lists pl
         where pl.organization_id=$1 and ($2='' or pl.status=$2)
         order by pl.created_at desc limit $3 offset $4`,
        [orgId, status, limit, offset])
      return rows.rows
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/wms/pick-lists', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      shipmentId: z.string().uuid().optional(),
      salesOrderId: z.string().uuid().optional(),
      items: z.array(z.object({
        productId: z.string().uuid(),
        locationId: z.string().uuid().optional(),
        qtyExpected: z.number().positive(),
      })).min(1),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `insert into pick_lists (organization_id, shipment_id, sales_order_id, created_by)
         values ($1,$2,$3,$4) returning id`,
        [orgId, data.shipmentId??null, data.salesOrderId??null, user.id])
      const plId = r.rows[0].id as string
      for (const item of data.items) {
        await c.query(
          `insert into pick_list_items (organization_id, pick_list_id, product_id, location_id, qty_expected)
           values ($1,$2,$3,$4,$5)`,
          [orgId, plId, item.productId, item.locationId??null, item.qtyExpected])
      }
      return { id: plId }
    })
    res.status(201).json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.post('/wms/pick-lists/:id/confirm-item', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const plId = req.params.id
    const data = z.object({
      itemId: z.string().uuid(),
      qtyPicked: z.number().nonnegative(),
      barcodeScanned: z.string().optional(),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update pick_list_items set qty_picked=$4, barcode_scanned=$5, picked_at=now()
         where organization_id=$1 and pick_list_id=$2 and id=$3 returning id`,
        [orgId, plId, data.itemId, data.qtyPicked, data.barcodeScanned??null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Item não encontrado na pick list.')
      // Check if all items are picked
      const remaining = await c.query(
        `select count(*)::int as cnt from pick_list_items where organization_id=$1 and pick_list_id=$2 and picked_at is null`,
        [orgId, plId])
      if (Number(remaining.rows[0]?.cnt ?? 0) === 0) {
        await c.query(`update pick_lists set status='picked', picked_at=now(), updated_at=now() where organization_id=$1 and id=$2`, [orgId, plId])
      } else {
        await c.query(`update pick_lists set status='picking', updated_at=now() where organization_id=$1 and id=$2 and status='pending'`, [orgId, plId])
      }
      return { confirmed: true }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.patch('/wms/pick-lists/:id/pack', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const plId = req.params.id
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update pick_lists set status='packed', packed_at=now(), updated_at=now()
         where organization_id=$1 and id=$2 and status in ('picked','packing') returning id`,
        [orgId, plId])
      if ((r.rowCount ?? 0) === 0) throw new Error('Pick list não está no status correto para embalar.')
      return { packed: true }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── Cubage ───────────────────────────────────────────────────────────────────
router.post('/wms/cubage', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const data = z.object({
      items: z.array(z.object({
        productId: z.string().uuid(),
        quantity: z.number().positive(),
      })).min(1),
    }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const productIds = data.items.map(i => i.productId)
      const products = await c.query(
        `select id, name, weight_kg, width_cm, height_cm, depth_cm from products
         where organization_id=$1 and id=any($2::uuid[])`,
        [orgId, productIds])
      const productMap = new Map(products.rows.map((p: Record<string, unknown>) => [p.id as string, p]))
      let totalWeight = 0
      let totalVolume = 0
      const details = data.items.map(item => {
        const p = productMap.get(item.productId) as Record<string, unknown> | undefined
        const weight = Number(p?.weight_kg ?? 0) * item.quantity
        const volume = (Number(p?.width_cm ?? 0) * Number(p?.height_cm ?? 0) * Number(p?.depth_cm ?? 0) / 1000000) * item.quantity
        totalWeight += weight
        totalVolume += volume
        return { productId: item.productId, productName: p?.name ?? '', quantity: item.quantity, weightKg: weight, volumeM3: Number(volume.toFixed(6)) }
      })
      return { totalWeightKg: Number(totalWeight.toFixed(3)), totalVolumeM3: Number(totalVolume.toFixed(6)), items: details }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── PATCH/DELETE Locations ───────────────────────────────────────────────────
router.patch('/wms/locations/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    const data = z.object({ active: z.boolean().optional() }).parse(req.body)
    const result = await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(
        `update warehouse_locations set active=coalesce($3, active), updated_at=now()
         where organization_id=$1 and id=$2 returning id`,
        [orgId, id, data.active ?? null])
      if ((r.rowCount ?? 0) === 0) throw new Error('Endereço não encontrado.')
      return r.rows[0]
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

router.delete('/wms/locations/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const id = z.string().uuid().parse(req.params.id)
    await withOrgTransaction(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const r = await c.query(`delete from warehouse_locations where organization_id=$1 and id=$2`, [orgId, id])
      if ((r.rowCount ?? 0) === 0) throw new Error('Endereço não encontrado.')
    })
    res.json({ deleted: true })
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

// ── GET Pick List Detail ────────────────────────────────────────────────────
router.get('/wms/pick-lists/:id', async (req, res) => {
  try {
    const orgId = getOrganizationId(req)
    const user = await getAuthUser(req.header('authorization'))
    const plId = req.params.id
    const result = await withOrgRead(orgId, async (c) => {
      await assertOrgMember(c, orgId, user.id)
      const pl = await c.query(
        `select id, status, shipment_id as "shipmentId", sales_order_id as "salesOrderId",
                picked_at as "pickedAt", packed_at as "packedAt", created_at as "createdAt"
         from pick_lists where organization_id=$1 and id=$2`, [orgId, plId])
      if ((pl.rowCount ?? 0) === 0) throw new Error('Pick list não encontrada.')
      const items = await c.query(
        `select pli.id, pli.product_id as "productId", p.name as "productName",
                pli.location_id as "locationId", wl.code as "locationCode",
                pli.qty_expected as "qtyExpected", pli.qty_picked as "qtyPicked",
                pli.barcode_scanned as "barcodeScanned", pli.picked_at as "pickedAt"
         from pick_list_items pli
         join products p on p.id=pli.product_id
         left join warehouse_locations wl on wl.id=pli.location_id
         where pli.organization_id=$1 and pli.pick_list_id=$2
         order by pli.id`, [orgId, plId])
      return { pickList: pl.rows[0], items: items.rows }
    })
    res.json(result)
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Erro.' }) }
})

export { router as wmsRoutes }
