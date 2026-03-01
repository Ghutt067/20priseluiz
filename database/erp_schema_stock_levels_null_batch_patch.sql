-- Patch de integridade para stock_levels com batch_id nulo
-- Objetivo: impedir múltiplas linhas null-batch para o mesmo produto+depósito

lock table stock_levels in share row exclusive mode;

with ranked as (
  select
    id,
    organization_id,
    product_id,
    warehouse_id,
    sum(qty_available) over (
      partition by organization_id, product_id, warehouse_id
    ) as total_qty_available,
    sum(qty_reserved) over (
      partition by organization_id, product_id, warehouse_id
    ) as total_qty_reserved,
    max(min_qty) over (
      partition by organization_id, product_id, warehouse_id
    ) as merged_min_qty,
    max(max_qty) over (
      partition by organization_id, product_id, warehouse_id
    ) as merged_max_qty,
    row_number() over (
      partition by organization_id, product_id, warehouse_id
      order by updated_at desc, id desc
    ) as rn
  from stock_levels
  where batch_id is null
),
updated as (
  update stock_levels sl
  set qty_available = ranked.total_qty_available,
      qty_reserved = ranked.total_qty_reserved,
      min_qty = ranked.merged_min_qty,
      max_qty = ranked.merged_max_qty,
      updated_at = now()
  from ranked
  where sl.id = ranked.id
    and ranked.rn = 1
  returning sl.id
)
delete from stock_levels sl
using ranked
where sl.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists stock_levels_unique_null_batch_idx
  on stock_levels (organization_id, product_id, warehouse_id)
  where batch_id is null;
