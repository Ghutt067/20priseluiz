-- Patch financeiro (contas e banco)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'bank_tx_direction') then
    create type bank_tx_direction as enum ('in', 'out');
  end if;
  if not exists (select 1 from pg_type where typname = 'bank_tx_status') then
    create type bank_tx_status as enum ('pending', 'cleared', 'reconciled');
  end if;
end $$;

create table if not exists bank_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  account_id uuid references financial_accounts(id),
  direction bank_tx_direction not null,
  amount numeric(18,2) not null,
  description text,
  external_ref text,
  occurred_at timestamptz not null default now(),
  status bank_tx_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists bank_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  reconciliation_id uuid not null references bank_reconciliations(id) on delete cascade,
  bank_transaction_id uuid not null references bank_transactions(id) on delete cascade,
  installment_id uuid references financial_installments(id),
  created_at timestamptz not null default now(),
  unique (organization_id, bank_transaction_id)
);

alter table bank_transactions enable row level security;
alter table bank_reconciliation_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'bank_transactions') then
    create policy tenant_select on bank_transactions
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'bank_transactions') then
    create policy tenant_insert on bank_transactions
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'bank_transactions') then
    create policy tenant_update on bank_transactions
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'bank_transactions') then
    create policy tenant_delete on bank_transactions
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'bank_reconciliation_items') then
    create policy tenant_select on bank_reconciliation_items
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'bank_reconciliation_items') then
    create policy tenant_insert on bank_reconciliation_items
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'bank_reconciliation_items') then
    create policy tenant_update on bank_reconciliation_items
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'bank_reconciliation_items') then
    create policy tenant_delete on bank_reconciliation_items
    for delete using (has_org_access(organization_id));
  end if;
end $$;
