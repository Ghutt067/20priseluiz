-- Compras fase 2: recebimento parcial por linha de ordem
-- Objetivo: permitir múltiplos recebimentos para a mesma ordem, com conferência de saldo por item.

-- 1) Vincula itens de recebimento à linha da ordem de compra.
alter table if exists purchase_receipt_items
  add column if not exists purchase_order_item_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_receipt_items_purchase_order_item_id_fkey'
  ) then
    alter table purchase_receipt_items
      add constraint purchase_receipt_items_purchase_order_item_id_fkey
      foreign key (purchase_order_item_id)
      references purchase_order_items(id)
      on delete set null;
  end if;
end
$$;

create index if not exists idx_purchase_receipt_items_order_item
  on purchase_receipt_items (organization_id, purchase_order_item_id)
  where purchase_order_item_id is not null;

create index if not exists idx_purchase_receipt_items_purchase_order_item_id
  on purchase_receipt_items (purchase_order_item_id);

-- 2) Remove bloqueio de recebimento único por ordem (agora suporta parcial/múltiplos).
drop trigger if exists trg_prevent_duplicate_purchase_receipt_for_order on purchase_receipts;
drop function if exists public.prevent_duplicate_purchase_receipt_for_order();
