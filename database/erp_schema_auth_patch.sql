-- Patch: Auth, Roles e RLS para onboarding e equipe
-- Execute no SQL Editor do Supabase.

-- 1) Roles
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('chefe', 'vendedor', 'estoquista', 'financeiro');
  end if;
end $$;

-- 2) Ajustar organization_users.role
alter table organization_users alter column role drop default;

update organization_users
set role = 'chefe'
where role = 'admin';

alter table organization_users
  alter column role type user_role using role::user_role,
  alter column role set default 'chefe';

-- 3) Ajustar profiles para conter role e organization_id
alter table profiles
  add column if not exists organization_id uuid references organizations(id) on delete cascade;

alter table profiles
  add column if not exists role text default 'chefe';

update profiles
set role = 'chefe'
where role is null;

alter table profiles alter column role drop default;
alter table profiles
  alter column role type user_role using role::user_role,
  alter column role set default 'chefe';

update profiles p
set organization_id = ou.organization_id,
    role = ou.role
from organization_users ou
where p.id = ou.user_id
  and p.organization_id is null;

-- 4) Função para checar admin
create or replace function is_org_admin(org_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from organization_users ou
    where ou.organization_id = org_id
      and ou.user_id = auth.uid()
      and ou.role = 'chefe'
  );
$$;

-- 5) RLS - profiles
drop policy if exists profiles_select on profiles;
drop policy if exists profiles_update on profiles;
drop policy if exists profiles_insert on profiles;

create policy profiles_select on profiles
for select using (
  id = auth.uid() or is_org_admin(organization_id)
);

create policy profiles_update on profiles
for update using (
  id = auth.uid() or is_org_admin(organization_id)
) with check (
  id = auth.uid() or is_org_admin(organization_id)
);

create policy profiles_insert on profiles
for insert with check (id = auth.uid());

-- 6) RLS - organization_users (somente chefe pode gerir equipe)
drop policy if exists org_users_select on organization_users;
drop policy if exists org_users_insert on organization_users;
drop policy if exists org_users_update on organization_users;
drop policy if exists org_users_delete on organization_users;

create policy org_users_select on organization_users
for select using (user_id = auth.uid() or is_org_member(organization_id));

create policy org_users_insert on organization_users
for insert with check (is_org_admin(organization_id));

create policy org_users_update on organization_users
for update using (is_org_admin(organization_id)) with check (is_org_admin(organization_id));

create policy org_users_delete on organization_users
for delete using (is_org_admin(organization_id));
