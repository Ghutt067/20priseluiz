-- Patch funcionarios, comissao e emprestimo
do $$
begin
  if not exists (select 1 from pg_type where typname = 'employee_status') then
    create type employee_status as enum ('active', 'inactive');
  end if;
  if not exists (select 1 from pg_type where typname = 'loan_status') then
    create type loan_status as enum ('open', 'returned', 'overdue', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'commission_status') then
    create type commission_status as enum ('pending', 'paid', 'canceled');
  end if;
end $$;

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  status employee_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sales_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_id uuid references employees(id),
  name text not null,
  commission_rate numeric(10,4) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists sales_commissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sales_order_id uuid references sales_orders(id),
  agent_id uuid references sales_agents(id),
  amount numeric(18,2) not null default 0,
  status commission_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists loan_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  status loan_status not null default 'open',
  expected_return_date date,
  returned_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists loan_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  loan_order_id uuid not null references loan_orders(id) on delete cascade,
  product_id uuid references products(id),
  quantity numeric(18,4) not null default 1
);

create trigger employees_updated_at before update on employees
for each row execute function set_updated_at();
create trigger loan_orders_updated_at before update on loan_orders
for each row execute function set_updated_at();

alter table employees enable row level security;
alter table sales_agents enable row level security;
alter table sales_commissions enable row level security;
alter table loan_orders enable row level security;
alter table loan_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'employees') then
    create policy tenant_select on employees
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'employees') then
    create policy tenant_insert on employees
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'employees') then
    create policy tenant_update on employees
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'employees') then
    create policy tenant_delete on employees
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'sales_agents') then
    create policy tenant_select on sales_agents
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'sales_agents') then
    create policy tenant_insert on sales_agents
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'sales_agents') then
    create policy tenant_update on sales_agents
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'sales_agents') then
    create policy tenant_delete on sales_agents
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'sales_commissions') then
    create policy tenant_select on sales_commissions
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'sales_commissions') then
    create policy tenant_insert on sales_commissions
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'sales_commissions') then
    create policy tenant_update on sales_commissions
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'sales_commissions') then
    create policy tenant_delete on sales_commissions
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'loan_orders') then
    create policy tenant_select on loan_orders
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'loan_orders') then
    create policy tenant_insert on loan_orders
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'loan_orders') then
    create policy tenant_update on loan_orders
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'loan_orders') then
    create policy tenant_delete on loan_orders
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'loan_items') then
    create policy tenant_select on loan_items
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'loan_items') then
    create policy tenant_insert on loan_items
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'loan_items') then
    create policy tenant_update on loan_items
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'loan_items') then
    create policy tenant_delete on loan_items
    for delete using (has_org_access(organization_id));
  end if;
end $$;
