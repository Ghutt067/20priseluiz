-- Patch etiquetas e comissão por venda
do $$
begin
  if not exists (select 1 from pg_type where typname = 'label_status') then
    create type label_status as enum ('pending', 'printed');
  end if;
end $$;

alter table sales_orders
  add column if not exists sales_agent_id uuid references sales_agents(id);

create table if not exists labels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid references products(id),
  quantity int not null default 1,
  payload jsonb,
  status label_status not null default 'pending',
  created_at timestamptz not null default now()
);

alter table labels enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'labels') then
    create policy tenant_select on labels
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'labels') then
    create policy tenant_insert on labels
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'labels') then
    create policy tenant_update on labels
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'labels') then
    create policy tenant_delete on labels
    for delete using (has_org_access(organization_id));
  end if;
end $$;
