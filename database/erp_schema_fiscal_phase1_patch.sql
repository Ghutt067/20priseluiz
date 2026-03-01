-- Patch fiscal phase 1 (aplicar em base existente)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'document_environment') then
    create type document_environment as enum ('production', 'homologation');
  end if;

  if not exists (select 1 from pg_type where typname = 'party_role') then
    create type party_role as enum ('emitter', 'recipient');
  end if;
end $$;

alter table if exists fiscal_documents
  add column if not exists environment document_environment not null default 'homologation',
  add column if not exists model smallint,
  add column if not exists series int,
  add column if not exists number int,
  add column if not exists total_products numeric(18,2) not null default 0,
  add column if not exists total_taxes numeric(18,2) not null default 0,
  add column if not exists total_invoice numeric(18,2) not null default 0;

alter table if exists fiscal_documents
  alter column series type int using nullif(series::text, '')::int,
  alter column number type int using nullif(number::text, '')::int;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fiscal_documents_unique_series_number'
  ) then
    alter table fiscal_documents
      add constraint fiscal_documents_unique_series_number
      unique (organization_id, doc_type, series, number);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'fiscal_documents_unique_access_key'
  ) then
    alter table fiscal_documents
      add constraint fiscal_documents_unique_access_key
      unique (organization_id, access_key);
  end if;
end $$;

alter table if exists fiscal_document_items
  add column if not exists uom text;

create table if not exists fiscal_document_parties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  role party_role not null,
  name text not null,
  legal_name text,
  cpf_cnpj text,
  ie text,
  im text,
  email text,
  phone text,
  street text,
  number text,
  complement text,
  district text,
  city text,
  state text,
  postal_code text,
  country text default 'BR',
  created_at timestamptz not null default now(),
  unique (organization_id, document_id, role)
);

create table if not exists fiscal_tax_calculations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  profile_id uuid references fiscal_tax_profiles(id),
  tax_regime tax_regime not null,
  total_products numeric(18,2) not null default 0,
  total_taxes numeric(18,2) not null default 0,
  total_invoice numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, document_id)
);

create table if not exists fiscal_tax_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  document_item_id uuid references fiscal_document_items(id) on delete cascade,
  tax_type tax_type not null,
  base_value numeric(18,2) not null default 0,
  rate numeric(10,4) not null default 0,
  amount numeric(18,2) not null default 0,
  cst text,
  csosn text,
  created_at timestamptz not null default now()
);

alter table fiscal_document_parties enable row level security;
alter table fiscal_tax_calculations enable row level security;
alter table fiscal_tax_lines enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'fiscal_document_parties') then
    create policy tenant_select on fiscal_document_parties
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'fiscal_document_parties') then
    create policy tenant_insert on fiscal_document_parties
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'fiscal_document_parties') then
    create policy tenant_update on fiscal_document_parties
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'fiscal_document_parties') then
    create policy tenant_delete on fiscal_document_parties
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'fiscal_tax_calculations') then
    create policy tenant_select on fiscal_tax_calculations
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'fiscal_tax_calculations') then
    create policy tenant_insert on fiscal_tax_calculations
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'fiscal_tax_calculations') then
    create policy tenant_update on fiscal_tax_calculations
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'fiscal_tax_calculations') then
    create policy tenant_delete on fiscal_tax_calculations
    for delete using (has_org_access(organization_id));
  end if;

  if not exists (select 1 from pg_policies where policyname = 'tenant_select' and tablename = 'fiscal_tax_lines') then
    create policy tenant_select on fiscal_tax_lines
    for select using (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_insert' and tablename = 'fiscal_tax_lines') then
    create policy tenant_insert on fiscal_tax_lines
    for insert with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_update' and tablename = 'fiscal_tax_lines') then
    create policy tenant_update on fiscal_tax_lines
    for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_delete' and tablename = 'fiscal_tax_lines') then
    create policy tenant_delete on fiscal_tax_lines
    for delete using (has_org_access(organization_id));
  end if;
end $$;
