-- Patch oficina/auto center
do $$
begin
  if not exists (select 1 from pg_type where typname = 'service_time_entry_type') then
    create type service_time_entry_type as enum ('labor', 'diagnostic');
  end if;
end $$;

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  plate text,
  brand text,
  model text,
  year int,
  color text,
  vin text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table service_orders
  add column if not exists vehicle_id uuid references vehicles(id);

create table if not exists service_time_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service_order_id uuid not null references service_orders(id) on delete cascade,
  technician_id uuid references technicians(id),
  entry_type service_time_entry_type not null default 'labor',
  hours numeric(10,2) not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

create trigger vehicles_updated_at before update on vehicles
for each row execute function set_updated_at();

alter table vehicles enable row level security;
alter table service_time_entries enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'vehicles') then
    create policy tenant_select on vehicles
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'vehicles') then
    create policy tenant_insert on vehicles
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'vehicles') then
    create policy tenant_update on vehicles
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'vehicles') then
    create policy tenant_delete on vehicles
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'service_time_entries') then
    create policy tenant_select on service_time_entries
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'service_time_entries') then
    create policy tenant_insert on service_time_entries
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'service_time_entries') then
    create policy tenant_update on service_time_entries
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'service_time_entries') then
    create policy tenant_delete on service_time_entries
    for delete using (has_org_access(organization_id));
  end if;
end $$;
