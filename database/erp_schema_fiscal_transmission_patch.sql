-- Patch transmissão fiscal (fila/estado)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'fiscal_transmission_status') then
    create type fiscal_transmission_status as enum ('queued', 'sent', 'authorized', 'rejected', 'error');
  end if;
end $$;

create table if not exists fiscal_transmissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  status fiscal_transmission_status not null default 'queued',
  response_code text,
  response_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger fiscal_transmissions_updated_at before update on fiscal_transmissions
for each row execute function set_updated_at();

alter table fiscal_transmissions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'fiscal_transmissions') then
    create policy tenant_select on fiscal_transmissions
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'fiscal_transmissions') then
    create policy tenant_insert on fiscal_transmissions
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'fiscal_transmissions') then
    create policy tenant_update on fiscal_transmissions
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'fiscal_transmissions') then
    create policy tenant_delete on fiscal_transmissions
    for delete using (has_org_access(organization_id));
  end if;
end $$;
