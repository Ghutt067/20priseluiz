-- Patch: busca rapida com pg_trgm para catalogos grandes
create extension if not exists pg_trgm;

create index if not exists products_name_trgm_idx
  on products using gin (name gin_trgm_ops);

create index if not exists products_sku_trgm_idx
  on products using gin (sku gin_trgm_ops);

create index if not exists products_brand_trgm_idx
  on products using gin (brand gin_trgm_ops);

create index if not exists products_barcode_trgm_idx
  on products using gin (barcode gin_trgm_ops);

create index if not exists products_sku_idx
  on products (sku);

create index if not exists products_barcode_idx
  on products (barcode);
