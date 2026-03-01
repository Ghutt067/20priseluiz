-- Patch cheques/cartoes e cotacoes
do $$
begin
  if not exists (select 1 from pg_type where typname = 'cheque_status') then
    create type cheque_status as enum ('pending', 'cleared', 'bounced', 'cancelled');
  end if;
end $$;

create table if not exists cheque_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_id uuid references financial_titles(id),
  bank text,
  agency text,
  account text,
  cheque_number text,
  due_date date,
  amount numeric(18,2) not null,
  status cheque_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists card_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_id uuid references financial_titles(id),
  brand text,
  holder_name text,
  last4 text,
  installments int not null default 1,
  amount numeric(18,2) not null,
  status text not null default 'authorized',
  created_at timestamptz not null default now()
);

alter table cheque_payments enable row level security;
alter table card_payments enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'cheque_payments') then
    create policy tenant_select on cheque_payments
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'cheque_payments') then
    create policy tenant_insert on cheque_payments
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'cheque_payments') then
    create policy tenant_update on cheque_payments
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'cheque_payments') then
    create policy tenant_delete on cheque_payments
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'card_payments') then
    create policy tenant_select on card_payments
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'card_payments') then
    create policy tenant_insert on card_payments
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'card_payments') then
    create policy tenant_update on card_payments
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'card_payments') then
    create policy tenant_delete on card_payments
    for delete using (has_org_access(organization_id));
  end if;
end $$;
