-- Patch: campos opcionais para busca visual de produtos
alter table products
  add column if not exists brand text,
  add column if not exists barcode text,
  add column if not exists image_url text;

create index if not exists products_search_idx
  on products (name, sku, brand, barcode);
