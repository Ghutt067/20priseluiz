import { Router } from 'express'
import { getOrganizationId } from '../src/http/getOrganizationId'
import { withOrgTransaction } from '../src/db'

const router = Router()

router.get('/products/search', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const query = String(request.query.query ?? '').trim().toLowerCase()
    const warehouseId = String(request.query.warehouseId ?? '').trim()
    const likeQuery = `%${query}%`

    const result = await withOrgTransaction(organizationId, async (client) => {
      await client.query('select set_limit($1)', [0.1])
      const primary = await client.query(
        `
        select
          p.id,
          p.sku,
          p.name,
          p.brand,
          p.barcode,
          p.image_url,
          p.price,
          coalesce(sum(sl.qty_available - sl.qty_reserved), 0) as stock_available,
          greatest(
            similarity(p.name_search, unaccent($3)),
            similarity(p.sku_search, unaccent($3)),
            similarity(p.brand_search, unaccent($3)),
            similarity(p.barcode_search, unaccent($3)),
            word_similarity(p.name_search, unaccent($3)),
            word_similarity(p.brand_search, unaccent($3))
          ) as similarity_score,
          case
            when p.barcode_search = unaccent($3) then 100
            when p.sku_search = unaccent($3) then 90
            when p.name_search like unaccent($4) then 70
            when p.brand_search like unaccent($4) then 60
            else 0
          end as exact_score
        from products p
        left join stock_levels sl
          on sl.product_id = p.id
         and sl.organization_id = p.organization_id
         and ($2 = '' or sl.warehouse_id::text = $2)
        where p.organization_id = $1
          and (
            $3 = '' or
            p.name_search % unaccent($3) or
            p.sku_search % unaccent($3) or
            p.brand_search % unaccent($3) or
            p.barcode_search % unaccent($3) or
            p.name_search like unaccent($4) or
            p.sku_search like unaccent($4) or
            p.brand_search like unaccent($4) or
            p.barcode_search like unaccent($4)
          )
        group by p.id
        order by
          exact_score desc,
          similarity_score desc,
          p.name asc
        limit 30
        `,
        [organizationId, warehouseId, query, likeQuery],
      )

      if (primary.rows.length > 0 || query.length < 3) {
        return primary
      }

      const fallback = await client.query(
        `
        select
          p.id,
          p.sku,
          p.name,
          p.brand,
          p.barcode,
          p.image_url,
          p.price,
          coalesce(sum(sl.qty_available - sl.qty_reserved), 0) as stock_available
        from products p
        left join stock_levels sl
          on sl.product_id = p.id
         and sl.organization_id = p.organization_id
         and ($2 = '' or sl.warehouse_id::text = $2)
        where p.organization_id = $1
        group by p.id
        order by
          greatest(
            similarity(p.name_search, unaccent($3)),
            similarity(p.sku_search, unaccent($3)),
            similarity(p.brand_search, unaccent($3)),
            similarity(p.barcode_search, unaccent($3)),
            word_similarity(p.name_search, unaccent($3)),
            word_similarity(p.brand_search, unaccent($3))
          ) desc,
          p.name asc
        limit 15
        `,
        [organizationId, warehouseId, query],
      )

      return fallback
    })

    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export { router as productsSearchRoute }
