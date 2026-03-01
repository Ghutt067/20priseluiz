Flash Search (busca ultra inteligente)

Este pacote serve para copiar o mesmo sistema de busca (rápido + tolerante a erros)
para outros projetos.

O que ele faz:
- Busca fuzzy e tolerante a erros (ex: "sloke" -> "smoke")
- Ignora acentos (cafe -> café)
- Prioriza barcode e SKU exatos
- Continua rápido com índices e pg_trgm

O que aplicar no banco (Supabase SQL Editor):
1) sql/erp_schema_products_search_patch.sql
2) sql/erp_schema_products_search_fast_patch.sql
3) sql/erp_schema_products_search_ai_patch.sql

Backend:
- Veja backend/products-search-route.ts para a rota /products/search

Frontend:
- Veja frontend/searchProducts.ts para a chamada de busca com AbortController

Observações:
- Se o catálogo for muito grande, mantenha o limit 30 (ou menos).
- Você pode ajustar a sensibilidade em set_limit(0.1) para 0.08 se quiser
  ainda mais tolerância a erro.
