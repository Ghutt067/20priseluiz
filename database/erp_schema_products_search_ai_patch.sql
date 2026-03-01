-- Patch: busca inteligente com unaccent + colunas normalizadas
create extension if not exists unaccent;

alter table products
  add column if not exists name_search text,
  add column if not exists brand_search text,
  add column if not exists sku_search text,
  add column if not exists barcode_search text;

create or replace function set_products_search()
returns trigger
language plpgsql
as $$
begin
  new.name_search = unaccent(lower(new.name));
  new.brand_search = unaccent(lower(coalesce(new.brand, '')));
  new.sku_search = unaccent(lower(coalesce(new.sku, '')));
  new.barcode_search = unaccent(lower(coalesce(new.barcode, '')));
  return new;
end;
$$;

drop trigger if exists products_search_tgr on products;
create trigger products_search_tgr
before insert or update on products
for each row execute function set_products_search();

update products
set
  name_search = unaccent(lower(name)),
  brand_search = unaccent(lower(coalesce(brand, ''))),
  sku_search = unaccent(lower(coalesce(sku, ''))),
  barcode_search = unaccent(lower(coalesce(barcode, '')));

create index if not exists products_name_search_trgm_idx
  on products using gin (name_search gin_trgm_ops);

create index if not exists products_brand_search_trgm_idx
  on products using gin (brand_search gin_trgm_ops);

create index if not exists products_sku_search_trgm_idx
  on products using gin (sku_search gin_trgm_ops);

create index if not exists products_barcode_search_trgm_idx
  on products using gin (barcode_search gin_trgm_ops);

create index if not exists products_sku_search_idx
  on products (sku_search);

create index if not exists products_barcode_search_idx
  on products (barcode_search);
