-- Patch Sintegra (estrutura)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'sintegra_status') then
    create type sintegra_status as enum ('draft', 'generated', 'sent', 'error');
  end if;
end $$;

create table if not exists sintegra_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status sintegra_status not null default 'draft',
  generated_at timestamptz,
  file_text text,
  created_at timestamptz not null default now()
);

alter table sintegra_exports enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'sintegra_exports') then
    create policy tenant_select on sintegra_exports
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'sintegra_exports') then
    create policy tenant_insert on sintegra_exports
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'sintegra_exports') then
    create policy tenant_update on sintegra_exports
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'sintegra_exports') then
    create policy tenant_delete on sintegra_exports
    for delete using (has_org_access(organization_id));
  end if;
end $$;
