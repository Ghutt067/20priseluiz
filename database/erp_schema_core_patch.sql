-- Patch core phase (compras e transferencias)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'purchase_order_status') then
    create type purchase_order_status as enum ('draft', 'approved', 'received', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'purchase_receipt_status') then
    create type purchase_receipt_status as enum ('pending', 'received', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'stock_transfer_status') then
    create type stock_transfer_status as enum ('pending', 'completed', 'cancelled');
  end if;
end $$;

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_id uuid references suppliers(id),
  warehouse_id uuid references warehouses(id),
  status purchase_order_status not null default 'draft',
  total_amount numeric(18,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_cost numeric(18,2) not null default 0,
  total_cost numeric(18,2) not null default 0
);

create table if not exists purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_order_id uuid references purchase_orders(id),
  supplier_id uuid references suppliers(id),
  warehouse_id uuid references warehouses(id),
  status purchase_receipt_status not null default 'pending',
  total_amount numeric(18,2) not null default 0,
  notes text,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists purchase_receipt_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_receipt_id uuid not null references purchase_receipts(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_cost numeric(18,2) not null default 0,
  total_cost numeric(18,2) not null default 0
);

create table if not exists stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  origin_warehouse_id uuid not null references warehouses(id),
  destination_warehouse_id uuid not null references warehouses(id),
  status stock_transfer_status not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  transfer_id uuid not null references stock_transfers(id) on delete cascade,
  product_id uuid not null references products(id),
  quantity numeric(18,4) not null default 1
);

create trigger purchase_orders_updated_at before update on purchase_orders
for each row execute function set_updated_at();
create trigger purchase_receipts_updated_at before update on purchase_receipts
for each row execute function set_updated_at();
create trigger stock_transfers_updated_at before update on stock_transfers
for each row execute function set_updated_at();

alter table purchase_orders enable row level security;
alter table purchase_order_items enable row level security;
alter table purchase_receipts enable row level security;
alter table purchase_receipt_items enable row level security;
alter table stock_transfers enable row level security;
alter table stock_transfer_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'purchase_orders') then
    create policy tenant_select on purchase_orders
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'purchase_orders') then
    create policy tenant_insert on purchase_orders
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'purchase_orders') then
    create policy tenant_update on purchase_orders
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'purchase_orders') then
    create policy tenant_delete on purchase_orders
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'purchase_order_items') then
    create policy tenant_select on purchase_order_items
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'purchase_order_items') then
    create policy tenant_insert on purchase_order_items
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'purchase_order_items') then
    create policy tenant_update on purchase_order_items
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'purchase_order_items') then
    create policy tenant_delete on purchase_order_items
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'purchase_receipts') then
    create policy tenant_select on purchase_receipts
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'purchase_receipts') then
    create policy tenant_insert on purchase_receipts
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'purchase_receipts') then
    create policy tenant_update on purchase_receipts
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'purchase_receipts') then
    create policy tenant_delete on purchase_receipts
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'purchase_receipt_items') then
    create policy tenant_select on purchase_receipt_items
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'purchase_receipt_items') then
    create policy tenant_insert on purchase_receipt_items
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'purchase_receipt_items') then
    create policy tenant_update on purchase_receipt_items
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'purchase_receipt_items') then
    create policy tenant_delete on purchase_receipt_items
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'stock_transfers') then
    create policy tenant_select on stock_transfers
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'stock_transfers') then
    create policy tenant_insert on stock_transfers
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'stock_transfers') then
    create policy tenant_update on stock_transfers
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'stock_transfers') then
    create policy tenant_delete on stock_transfers
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'stock_transfer_items') then
    create policy tenant_select on stock_transfer_items
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'stock_transfer_items') then
    create policy tenant_insert on stock_transfer_items
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'stock_transfer_items') then
    create policy tenant_update on stock_transfer_items
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'stock_transfer_items') then
    create policy tenant_delete on stock_transfer_items
    for delete using (has_org_access(organization_id));
  end if;
end $$;
