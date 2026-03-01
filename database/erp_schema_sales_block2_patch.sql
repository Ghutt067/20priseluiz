-- Block 2: Sales enhancements – payment condition, discount limit, updated_by

alter table sales_orders
  add column if not exists payment_condition text,
  add column if not exists discount_percent numeric(5,2) default 0,
  add column if not exists updated_by uuid references auth.users(id);

-- Per-role discount limits (e.g. vendedor max 10%, gerente max 30%)
create table if not exists discount_limits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  role_key text not null,
  max_discount_percent numeric(5,2) not null default 0,
  created_at timestamptz not null default now(),
  unique(organization_id, role_key)
);

alter table discount_limits enable row level security;
create policy discount_limits_tenant on discount_limits
  using (organization_id = current_setting('app.current_organization_id')::uuid);
