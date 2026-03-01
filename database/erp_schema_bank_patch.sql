-- Patch integrações bancárias (estrutura)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'bank_provider') then
    create type bank_provider as enum ('pix', 'boleto', 'bank_api');
  end if;
  if not exists (select 1 from pg_type where typname = 'bank_webhook_status') then
    create type bank_webhook_status as enum ('received', 'processed', 'failed');
  end if;
end $$;

create table if not exists bank_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider bank_provider not null,
  name text,
  config jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists bank_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  integration_id uuid references bank_integrations(id),
  event_type text not null,
  payload jsonb not null,
  status bank_webhook_status not null default 'received',
  created_at timestamptz not null default now()
);

alter table bank_integrations enable row level security;
alter table bank_webhook_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'bank_integrations') then
    create policy tenant_select on bank_integrations
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'bank_integrations') then
    create policy tenant_insert on bank_integrations
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'bank_integrations') then
    create policy tenant_update on bank_integrations
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'bank_integrations') then
    create policy tenant_delete on bank_integrations
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'bank_webhook_events') then
    create policy tenant_select on bank_webhook_events
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'bank_webhook_events') then
    create policy tenant_insert on bank_webhook_events
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'bank_webhook_events') then
    create policy tenant_update on bank_webhook_events
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'bank_webhook_events') then
    create policy tenant_delete on bank_webhook_events
    for delete using (has_org_access(organization_id));
  end if;
end $$;
