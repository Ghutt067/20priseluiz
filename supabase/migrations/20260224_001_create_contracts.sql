-- Contracts table for recurring billing
create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  customer_id uuid references customers(id),
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  start_date date not null,
  end_date date,
  billing_day smallint not null default 1 check (billing_day between 1 and 31),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_contracts_org on contracts(organization_id);
create index if not exists idx_contracts_status on contracts(organization_id, status);
create index if not exists idx_contracts_customer on contracts(organization_id, customer_id);

-- Contract line items
create table if not exists contract_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  contract_id uuid not null references contracts(id) on delete cascade,
  description text not null,
  quantity numeric(12,4) not null default 1,
  unit_price numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_contract_items_contract on contract_items(contract_id, organization_id);

-- RLS
alter table contracts enable row level security;
alter table contract_items enable row level security;

create policy "org_contracts_select" on contracts for select
  using (organization_id = current_setting('app.organization_id')::uuid);

create policy "org_contracts_insert" on contracts for insert
  with check (organization_id = current_setting('app.organization_id')::uuid);

create policy "org_contracts_update" on contracts for update
  using (organization_id = current_setting('app.organization_id')::uuid);

create policy "org_contract_items_select" on contract_items for select
  using (organization_id = current_setting('app.organization_id')::uuid);

create policy "org_contract_items_insert" on contract_items for insert
  with check (organization_id = current_setting('app.organization_id')::uuid);
