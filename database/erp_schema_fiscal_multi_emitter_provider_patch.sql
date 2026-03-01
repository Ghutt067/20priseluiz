-- Patch fiscal: multi-emitente + provedor PlugNotas
-- Aplicar em bancos já existentes.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'fiscal_provider') then
    create type fiscal_provider as enum ('plugnotas');
  end if;
end $$;

create table if not exists fiscal_emitters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  legal_name text,
  cnpj text not null,
  ie text,
  im text,
  tax_regime tax_regime not null default 'simples_nacional',
  street text,
  number text,
  complement text,
  district text,
  city text,
  state text,
  postal_code text,
  country text not null default 'BR',
  ibge_city_code text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fiscal_emitters_organization_cnpj_key'
  ) then
    alter table fiscal_emitters
      add constraint fiscal_emitters_organization_cnpj_key
      unique (organization_id, cnpj);
  end if;
end $$;

create unique index if not exists fiscal_emitters_one_default_idx
  on fiscal_emitters (organization_id)
  where is_default = true;

create index if not exists fiscal_emitters_org_name_idx
  on fiscal_emitters (organization_id, name);

create index if not exists fiscal_emitters_org_cnpj_idx
  on fiscal_emitters (organization_id, cnpj);

create table if not exists fiscal_provider_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider fiscal_provider not null,
  environment document_environment not null default 'homologation',
  api_base_url text,
  api_key text,
  company_api_key text,
  integration_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

alter table fiscal_transmissions
  add column if not exists provider fiscal_provider;

alter table fiscal_transmissions
  add column if not exists provider_reference text;

alter table fiscal_transmissions
  add column if not exists request_payload jsonb;

alter table fiscal_transmissions
  add column if not exists response_payload jsonb;

alter table fiscal_transmissions
  add column if not exists sent_at timestamptz;

alter table fiscal_transmissions
  add column if not exists authorized_at timestamptz;

with duplicated_active as (
  select id
  from (
    select id,
           row_number() over (
             partition by organization_id, document_id
             order by updated_at desc nulls last, created_at desc nulls last, id desc
           ) as row_index
    from fiscal_transmissions
    where status in ('queued', 'sent')
  ) ranked
  where row_index > 1
)
delete from fiscal_transmissions ft
using duplicated_active da
where ft.id = da.id;

create unique index if not exists fiscal_transmissions_active_document_idx
  on fiscal_transmissions (organization_id, document_id)
  where status in ('queued', 'sent');

create index if not exists fiscal_transmissions_org_doc_updated_idx
  on fiscal_transmissions (organization_id, document_id, updated_at desc);

alter table fiscal_documents
  add column if not exists emitter_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fiscal_documents_emitter_id_fkey'
  ) then
    alter table fiscal_documents
      add constraint fiscal_documents_emitter_id_fkey
      foreign key (emitter_id)
      references fiscal_emitters(id)
      on delete set null;
  end if;
end $$;

create index if not exists fiscal_documents_org_emitter_idx
  on fiscal_documents (organization_id, emitter_id);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'fiscal_emitters_updated_at') then
    create trigger fiscal_emitters_updated_at
    before update on fiscal_emitters
    for each row execute function set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'fiscal_provider_configs_updated_at') then
    create trigger fiscal_provider_configs_updated_at
    before update on fiscal_provider_configs
    for each row execute function set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'fiscal_transmissions_updated_at') then
    create trigger fiscal_transmissions_updated_at
    before update on fiscal_transmissions
    for each row execute function set_updated_at();
  end if;
end $$;

alter table fiscal_emitters enable row level security;
alter table fiscal_provider_configs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'fiscal_emitters') then
    create policy tenant_select on fiscal_emitters
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'fiscal_emitters') then
    create policy tenant_insert on fiscal_emitters
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'fiscal_emitters') then
    create policy tenant_update on fiscal_emitters
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'fiscal_emitters') then
    create policy tenant_delete on fiscal_emitters
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'fiscal_provider_configs') then
    create policy tenant_select on fiscal_provider_configs
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'fiscal_provider_configs') then
    create policy tenant_insert on fiscal_provider_configs
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'fiscal_provider_configs') then
    create policy tenant_update on fiscal_provider_configs
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'fiscal_provider_configs') then
    create policy tenant_delete on fiscal_provider_configs
    for delete using (has_org_access(organization_id));
  end if;
end $$;
