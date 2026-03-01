-- Patch CRM/agenda/promocoes/inventario/devolucao
do $$
begin
  if not exists (select 1 from pg_type where typname = 'appointment_status') then
    create type appointment_status as enum ('scheduled', 'completed', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'campaign_status') then
    create type campaign_status as enum ('draft', 'active', 'completed');
  end if;
  if not exists (select 1 from pg_type where typname = 'promotion_status') then
    create type promotion_status as enum ('scheduled', 'active', 'ended');
  end if;
  if not exists (select 1 from pg_type where typname = 'inventory_count_status') then
    create type inventory_count_status as enum ('draft', 'counted', 'adjusted');
  end if;
  if not exists (select 1 from pg_type where typname = 'return_status') then
    create type return_status as enum ('requested', 'approved', 'received', 'refunded');
  end if;
end $$;

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  subject text not null,
  scheduled_at timestamptz not null,
  status appointment_status not null default 'scheduled',
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists call_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  phone text,
  outcome text,
  notes text,
  occurred_at timestamptz not null default now()
);

create table if not exists marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  channel text,
  status campaign_status not null default 'draft',
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid not null references marketing_campaigns(id) on delete cascade,
  customer_id uuid references customers(id),
  email text,
  phone text,
  created_at timestamptz not null default now()
);

create table if not exists promotions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid references products(id),
  name text not null,
  promo_price numeric(18,2) not null,
  start_at timestamptz,
  end_at timestamptz,
  status promotion_status not null default 'scheduled',
  created_at timestamptz not null default now()
);

create table if not exists inventory_counts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  warehouse_id uuid references warehouses(id),
  status inventory_count_status not null default 'draft',
  counted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists inventory_count_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  count_id uuid not null references inventory_counts(id) on delete cascade,
  product_id uuid references products(id),
  expected_qty numeric(18,4) not null default 0,
  counted_qty numeric(18,4) not null default 0
);

create table if not exists return_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  status return_status not null default 'requested',
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists return_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  return_order_id uuid not null references return_orders(id) on delete cascade,
  product_id uuid references products(id),
  quantity numeric(18,4) not null default 1,
  condition text
);

alter table appointments enable row level security;
alter table call_logs enable row level security;
alter table marketing_campaigns enable row level security;
alter table campaign_contacts enable row level security;
alter table promotions enable row level security;
alter table inventory_counts enable row level security;
alter table inventory_count_items enable row level security;
alter table return_orders enable row level security;
alter table return_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'appointments') then
    create policy tenant_select on appointments
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'appointments') then
    create policy tenant_insert on appointments
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'appointments') then
    create policy tenant_update on appointments
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'appointments') then
    create policy tenant_delete on appointments
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'call_logs') then
    create policy tenant_select on call_logs
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'call_logs') then
    create policy tenant_insert on call_logs
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'call_logs') then
    create policy tenant_update on call_logs
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'call_logs') then
    create policy tenant_delete on call_logs
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'marketing_campaigns') then
    create policy tenant_select on marketing_campaigns
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'marketing_campaigns') then
    create policy tenant_insert on marketing_campaigns
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'marketing_campaigns') then
    create policy tenant_update on marketing_campaigns
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'marketing_campaigns') then
    create policy tenant_delete on marketing_campaigns
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'campaign_contacts') then
    create policy tenant_select on campaign_contacts
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'campaign_contacts') then
    create policy tenant_insert on campaign_contacts
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'campaign_contacts') then
    create policy tenant_update on campaign_contacts
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'campaign_contacts') then
    create policy tenant_delete on campaign_contacts
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'promotions') then
    create policy tenant_select on promotions
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'promotions') then
    create policy tenant_insert on promotions
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'promotions') then
    create policy tenant_update on promotions
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'promotions') then
    create policy tenant_delete on promotions
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'inventory_counts') then
    create policy tenant_select on inventory_counts
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'inventory_counts') then
    create policy tenant_insert on inventory_counts
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'inventory_counts') then
    create policy tenant_update on inventory_counts
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'inventory_counts') then
    create policy tenant_delete on inventory_counts
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'inventory_count_items') then
    create policy tenant_select on inventory_count_items
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'inventory_count_items') then
    create policy tenant_insert on inventory_count_items
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'inventory_count_items') then
    create policy tenant_update on inventory_count_items
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'inventory_count_items') then
    create policy tenant_delete on inventory_count_items
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'return_orders') then
    create policy tenant_select on return_orders
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'return_orders') then
    create policy tenant_insert on return_orders
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'return_orders') then
    create policy tenant_update on return_orders
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'return_orders') then
    create policy tenant_delete on return_orders
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'return_items') then
    create policy tenant_select on return_items
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'return_items') then
    create policy tenant_insert on return_items
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'return_items') then
    create policy tenant_update on return_items
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'return_items') then
    create policy tenant_delete on return_items
    for delete using (has_org_access(organization_id));
  end if;
end $$;
