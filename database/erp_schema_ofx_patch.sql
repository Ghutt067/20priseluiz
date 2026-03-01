-- Patch integração bancária (OFX)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'ofx_import_status') then
    create type ofx_import_status as enum ('pending', 'processed', 'failed');
  end if;
end $$;

create table if not exists ofx_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  account_id uuid references financial_accounts(id),
  status ofx_import_status not null default 'pending',
  raw_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists ofx_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  import_id uuid not null references ofx_imports(id) on delete cascade,
  account_id uuid references financial_accounts(id),
  fit_id text,
  posted_at timestamptz,
  amount numeric(18,2) not null,
  memo text,
  name text,
  created_at timestamptz not null default now()
);

alter table ofx_imports enable row level security;
alter table ofx_transactions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'ofx_imports') then
    create policy tenant_select on ofx_imports
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'ofx_imports') then
    create policy tenant_insert on ofx_imports
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'ofx_imports') then
    create policy tenant_update on ofx_imports
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'ofx_imports') then
    create policy tenant_delete on ofx_imports
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'ofx_transactions') then
    create policy tenant_select on ofx_transactions
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'ofx_transactions') then
    create policy tenant_insert on ofx_transactions
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'ofx_transactions') then
    create policy tenant_update on ofx_transactions
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'ofx_transactions') then
    create policy tenant_delete on ofx_transactions
    for delete using (has_org_access(organization_id));
  end if;
end $$;
