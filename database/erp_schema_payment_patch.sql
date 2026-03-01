-- Patch PIX/Boleto (estrutura)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_request_status') then
    create type payment_request_status as enum ('created', 'sent', 'paid', 'cancelled', 'expired');
  end if;
end $$;

create table if not exists payment_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_id uuid references financial_titles(id),
  provider bank_provider not null,
  amount numeric(18,2) not null,
  status payment_request_status not null default 'created',
  payload jsonb,
  created_at timestamptz not null default now()
);

alter table payment_requests enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'payment_requests') then
    create policy tenant_select on payment_requests
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'payment_requests') then
    create policy tenant_insert on payment_requests
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'payment_requests') then
    create policy tenant_update on payment_requests
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'payment_requests') then
    create policy tenant_delete on payment_requests
    for delete using (has_org_access(organization_id));
  end if;
end $$;
