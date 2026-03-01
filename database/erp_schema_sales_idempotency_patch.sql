create table if not exists request_idempotency (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id),
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  response_status integer not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, actor_user_id, operation, idempotency_key)
);

create index if not exists request_idempotency_org_created_idx
  on request_idempotency (organization_id, created_at desc);

alter table request_idempotency enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'request_idempotency'
      and policyname = 'tenant_select'
  ) then
    create policy tenant_select on request_idempotency
    for select using (has_org_access(organization_id));
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'request_idempotency'
      and policyname = 'tenant_insert'
  ) then
    create policy tenant_insert on request_idempotency
    for insert with check (has_org_access(organization_id));
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'request_idempotency'
      and policyname = 'tenant_update'
  ) then
    create policy tenant_update on request_idempotency
    for update using (has_org_access(organization_id))
    with check (has_org_access(organization_id));
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'request_idempotency'
      and policyname = 'tenant_delete'
  ) then
    create policy tenant_delete on request_idempotency
    for delete using (has_org_access(organization_id));
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_proc
    where proname = 'set_updated_at'
      and pg_function_is_visible(oid)
  )
  and not exists (
    select 1
    from pg_trigger
    where tgname = 'set_request_idempotency_updated_at'
  ) then
    create trigger set_request_idempotency_updated_at
    before update on request_idempotency
    for each row execute function set_updated_at();
  end if;
end $$;
