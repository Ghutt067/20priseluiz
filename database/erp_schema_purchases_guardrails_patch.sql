-- Guardrails comerciais para compras
-- Objetivo: reduzir inconsistências operacionais em ordens e recebimentos.

-- 1) Ordens aprovadas/recebidas devem ter fornecedor e depósito.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_orders_links_required_on_active_status'
  ) then
    alter table purchase_orders
      add constraint purchase_orders_links_required_on_active_status
      check (
        status in ('draft', 'cancelled')
        or (supplier_id is not null and warehouse_id is not null)
      ) not valid;
  end if;
end
$$;

-- 2) Itens de compra/recebimento exigem descrição com conteúdo.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_order_items_description_required'
  ) then
    alter table purchase_order_items
      add constraint purchase_order_items_description_required
      check (coalesce(length(trim(description)), 0) > 0) not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_receipt_items_description_required'
  ) then
    alter table purchase_receipt_items
      add constraint purchase_receipt_items_description_required
      check (coalesce(length(trim(description)), 0) > 0) not valid;
  end if;
end
$$;

-- 3) Recebimentos devem registrar fornecedor e depósito.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_receipts_supplier_required'
  ) then
    alter table purchase_receipts
      add constraint purchase_receipts_supplier_required
      check (supplier_id is not null) not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_receipts_warehouse_required'
  ) then
    alter table purchase_receipts
      add constraint purchase_receipts_warehouse_required
      check (warehouse_id is not null) not valid;
  end if;
end
$$;

-- 4) Índices operacionais para consultas de compras.
create index if not exists idx_purchase_orders_org_status_created_at
  on purchase_orders (organization_id, status, created_at desc);

create index if not exists idx_purchase_receipts_org_order_created_at
  on purchase_receipts (organization_id, purchase_order_id, created_at desc);

-- 5) Bloqueia recebimento ativo duplicado para a mesma ordem.
create or replace function prevent_duplicate_purchase_receipt_for_order()
returns trigger
language plpgsql
as $$
begin
  if new.purchase_order_id is null then
    return new;
  end if;

  if new.status = 'cancelled' then
    return new;
  end if;

  if exists (
    select 1
    from purchase_receipts pr
    where pr.organization_id = new.organization_id
      and pr.purchase_order_id = new.purchase_order_id
      and pr.status <> 'cancelled'
      and (tg_op = 'INSERT' or pr.id <> new.id)
  ) then
    raise exception 'Já existe um recebimento ativo para esta ordem de compra.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_duplicate_purchase_receipt_for_order on purchase_receipts;

create trigger trg_prevent_duplicate_purchase_receipt_for_order
before insert or update of purchase_order_id, status
on purchase_receipts
for each row
execute function prevent_duplicate_purchase_receipt_for_order();

alter function public.prevent_duplicate_purchase_receipt_for_order()
  set search_path = public;
