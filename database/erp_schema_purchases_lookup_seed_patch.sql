-- Seed de apoio para UX de Compras (lookups com paginação/infinite scroll)
-- Objetivo: garantir ao menos 10 itens de teste por organização em:
--   1) fornecedores
--   2) depósitos
--   3) produtos

-- 1) Fornecedores demo
insert into suppliers (
  organization_id,
  person_type,
  name,
  legal_name,
  email,
  phone,
  active
)
select
  org.id,
  'legal'::person_type,
  format('Fornecedor Demo %s', lpad(item.idx::text, 2, '0')),
  format('Fornecedor Demo %s LTDA', lpad(item.idx::text, 2, '0')),
  format('fornecedor.demo.%s@vinte.local', lpad(item.idx::text, 2, '0')),
  format('11999990%s', lpad(item.idx::text, 2, '0')),
  true
from organizations org
cross join generate_series(1, 10) as item(idx)
where not exists (
  select 1
  from suppliers s
  where s.organization_id = org.id
    and s.name = format('Fornecedor Demo %s', lpad(item.idx::text, 2, '0'))
);

-- 2) Depósitos demo
insert into warehouses (
  organization_id,
  name
)
select
  org.id,
  format('Depósito Demo %s', lpad(item.idx::text, 2, '0'))
from organizations org
cross join generate_series(1, 10) as item(idx)
where not exists (
  select 1
  from warehouses w
  where w.organization_id = org.id
    and w.name = format('Depósito Demo %s', lpad(item.idx::text, 2, '0'))
);

-- 3) Produtos demo
insert into products (
  organization_id,
  sku,
  name,
  description,
  product_type,
  uom,
  price,
  cost,
  active
)
select
  org.id,
  format('CMP-DEMO-%s', lpad(item.idx::text, 2, '0')),
  format('Produto Compra Demo %s', lpad(item.idx::text, 2, '0')),
  format('Produto de apoio para testes de lookup em Compras %s', lpad(item.idx::text, 2, '0')),
  'product'::product_type,
  'UN',
  (10 + item.idx)::numeric(18,2),
  (6 + (item.idx / 2.0))::numeric(18,2),
  true
from organizations org
cross join generate_series(1, 10) as item(idx)
on conflict (organization_id, sku) do nothing;
