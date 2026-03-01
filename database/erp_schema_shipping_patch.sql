-- Patch expedição/entrega
do $$
begin
  if not exists (select 1 from pg_type where typname = 'shipment_status') then
    create type shipment_status as enum ('pending', 'dispatched', 'delivered', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'shipment_type') then
    create type shipment_type as enum ('delivery', 'pickup');
  end if;
end $$;

create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sales_order_id uuid references sales_orders(id),
  customer_id uuid references customers(id),
  type shipment_type not null default 'delivery',
  status shipment_status not null default 'pending',
  carrier text,
  tracking_code text,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists shipment_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  shipment_id uuid not null references shipments(id) on delete cascade,
  product_id uuid references products(id),
  quantity numeric(18,4) not null default 1
);

alter table shipments enable row level security;
alter table shipment_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'shipments') then
    create policy tenant_select on shipments
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'shipments') then
    create policy tenant_insert on shipments
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'shipments') then
    create policy tenant_update on shipments
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'shipments') then
    create policy tenant_delete on shipments
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'shipment_items') then
    create policy tenant_select on shipment_items
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'shipment_items') then
    create policy tenant_insert on shipment_items
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'shipment_items') then
    create policy tenant_update on shipment_items
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'shipment_items') then
    create policy tenant_delete on shipment_items
    for delete using (has_org_access(organization_id));
  end if;
end $$;
