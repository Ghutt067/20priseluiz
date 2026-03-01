-- Flash-search style fuzzy search for suppliers and warehouses
-- Requires: pg_trgm, unaccent (already enabled by products search patches)

-- ===== Suppliers =====

alter table suppliers
  add column if not exists name_search text,
  add column if not exists legal_name_search text,
  add column if not exists cpf_cnpj_search text;

create or replace function set_suppliers_search()
returns trigger
language plpgsql
as $$
begin
  new.name_search = unaccent(lower(coalesce(new.name, '')));
  new.legal_name_search = unaccent(lower(coalesce(new.legal_name, '')));
  new.cpf_cnpj_search = unaccent(lower(coalesce(new.cpf_cnpj, '')));
  return new;
end;
$$;

drop trigger if exists suppliers_search_tgr on suppliers;
create trigger suppliers_search_tgr
before insert or update on suppliers
for each row execute function set_suppliers_search();

update suppliers
set
  name_search = unaccent(lower(coalesce(name, ''))),
  legal_name_search = unaccent(lower(coalesce(legal_name, ''))),
  cpf_cnpj_search = unaccent(lower(coalesce(cpf_cnpj, '')));

create index if not exists suppliers_name_search_trgm_idx
  on suppliers using gin (name_search gin_trgm_ops);

create index if not exists suppliers_legal_name_search_trgm_idx
  on suppliers using gin (legal_name_search gin_trgm_ops);

create index if not exists suppliers_cpf_cnpj_search_trgm_idx
  on suppliers using gin (cpf_cnpj_search gin_trgm_ops);

-- ===== Warehouses =====

alter table warehouses
  add column if not exists name_search text;

create or replace function set_warehouses_search()
returns trigger
language plpgsql
as $$
begin
  new.name_search = unaccent(lower(coalesce(new.name, '')));
  return new;
end;
$$;

drop trigger if exists warehouses_search_tgr on warehouses;
create trigger warehouses_search_tgr
before insert or update on warehouses
for each row execute function set_warehouses_search();

update warehouses
set name_search = unaccent(lower(coalesce(name, '')));

create index if not exists warehouses_name_search_trgm_idx
  on warehouses using gin (name_search gin_trgm_ops);

-- ===== Customers =====

alter table customers
  add column if not exists name_search text,
  add column if not exists phone_search text,
  add column if not exists cpf_cnpj_search text;

create or replace function set_customers_search()
returns trigger
language plpgsql
as $$
begin
  new.name_search = unaccent(lower(coalesce(new.name, '')));
  new.phone_search = unaccent(lower(coalesce(new.phone, '')));
  new.cpf_cnpj_search = unaccent(lower(coalesce(new.cpf_cnpj, '')));
  return new;
end;
$$;

drop trigger if exists customers_search_tgr on customers;
create trigger customers_search_tgr
before insert or update on customers
for each row execute function set_customers_search();

update customers
set
  name_search = unaccent(lower(coalesce(name, ''))),
  phone_search = unaccent(lower(coalesce(phone, ''))),
  cpf_cnpj_search = unaccent(lower(coalesce(cpf_cnpj, '')));

create index if not exists customers_name_search_trgm_idx
  on customers using gin (name_search gin_trgm_ops);

create index if not exists customers_phone_search_trgm_idx
  on customers using gin (phone_search gin_trgm_ops);

create index if not exists customers_cpf_cnpj_search_trgm_idx
  on customers using gin (cpf_cnpj_search gin_trgm_ops);
