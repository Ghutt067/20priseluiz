-- ERP Fiscal Brasileiro - Esquema PostgreSQL com RLS
-- Execute no SQL Editor do Supabase (uma vez).

create extension if not exists pgcrypto;

-- Tipos enumerados
create type tax_regime as enum ('simples_nacional', 'lucro_presumido', 'lucro_real', 'mei');
create type person_type as enum ('legal', 'natural');
create type product_type as enum ('product', 'service');
create type stock_movement_type as enum ('in', 'out', 'adjust', 'transfer');
create type document_type as enum ('nfe', 'nfse', 'nfce');
create type document_status as enum ('draft', 'authorized', 'cancelled', 'denied', 'error');
create type document_environment as enum ('production', 'homologation');
create type fiscal_event_type as enum ('cancelamento', 'cce', 'manifestacao');
create type financial_title_type as enum ('receivable', 'payable');
create type financial_status as enum ('open', 'paid', 'canceled', 'overdue');
create type payment_method as enum ('cash', 'card', 'pix', 'boleto', 'transfer', 'other');
create type pos_session_status as enum ('open', 'closed');
create type service_order_status as enum ('open', 'in_progress', 'completed', 'cancelled');
create type contract_status as enum ('active', 'paused', 'cancelled');
create type webhook_status as enum ('pending', 'processed', 'failed');
create type tax_type as enum ('icms', 'icms_st', 'icms_difal', 'pis', 'cofins', 'ipi', 'iss');
create type tax_profile_type as enum ('default', 'custom');
create type invoice_origin as enum ('sales_order', 'pos_sale', 'service_order');
create type party_role as enum ('emitter', 'recipient');
create type purchase_order_status as enum ('draft', 'approved', 'received', 'cancelled');
create type purchase_receipt_status as enum ('pending', 'received', 'cancelled');
create type stock_transfer_status as enum ('pending', 'completed', 'cancelled');
create type bank_tx_direction as enum ('in', 'out');
create type bank_tx_status as enum ('pending', 'cleared', 'reconciled');
create type service_time_entry_type as enum ('labor', 'diagnostic');
create type appointment_status as enum ('scheduled', 'completed', 'cancelled');
create type campaign_status as enum ('draft', 'active', 'completed');
create type promotion_status as enum ('scheduled', 'active', 'ended');
create type inventory_count_status as enum ('draft', 'counted', 'adjusted');
create type return_status as enum ('requested', 'approved', 'received', 'refunded');
create type shipment_status as enum ('pending', 'dispatched', 'delivered', 'cancelled');
create type shipment_type as enum ('delivery', 'pickup');
create type pos_payment_status as enum ('pending', 'paid', 'cancelled');
create type employee_status as enum ('active', 'inactive');
create type loan_status as enum ('open', 'returned', 'overdue', 'cancelled');
create type commission_status as enum ('pending', 'paid', 'canceled');
create type ofx_import_status as enum ('pending', 'processed', 'failed');
create type label_status as enum ('pending', 'printed');
create type bank_provider as enum ('pix', 'boleto', 'bank_api');
create type bank_webhook_status as enum ('received', 'processed', 'failed');
create type sintegra_status as enum ('draft', 'generated', 'sent', 'error');
create type payment_request_status as enum ('created', 'sent', 'paid', 'cancelled', 'expired');
create type fiscal_transmission_status as enum ('queued', 'sent', 'authorized', 'rejected', 'error');
create type fiscal_provider as enum ('plugnotas');
create type cheque_status as enum ('pending', 'cleared', 'bounced', 'cancelled');

-- Funcoes auxiliares para RLS
create or replace function current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.organization_id', true), '')::uuid;
$$;

-- Atualiza updated_at
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Tabelas core
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  cnpj text unique,
  ie text,
  im text,
  tax_regime tax_regime not null default 'simples_nacional',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organization_users (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'admin',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create or replace function is_org_member(org_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from organization_users ou
    where ou.organization_id = org_id
      and ou.user_id = auth.uid()
  );
$$;

create or replace function has_org_access(org_id uuid)
returns boolean
language sql
stable
as $$
  select (current_org_id() = org_id) and is_org_member(org_id);
$$;

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  operation text not null,
  table_name text not null,
  record_id text,
  old_data jsonb,
  new_data jsonb,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table fiscal_emitters (
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
  updated_at timestamptz not null default now(),
  unique (organization_id, cnpj)
);

create unique index fiscal_emitters_one_default_idx
  on fiscal_emitters (organization_id)
  where is_default = true;

create index fiscal_emitters_org_name_idx
  on fiscal_emitters (organization_id, name);

create index fiscal_emitters_org_cnpj_idx
  on fiscal_emitters (organization_id, cnpj);

create table fiscal_provider_configs (
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

create or replace function prevent_audit_log_changes()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

create trigger audit_log_no_update
before update or delete on audit_log
for each row execute function prevent_audit_log_changes();

-- Vault para certificados A1 (dados criptografados no app e armazenados como bytea)
create table vault_certificates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  alias text not null,
  encrypted_cert bytea not null,
  encrypted_private_key bytea not null,
  iv bytea not null,
  key_fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, alias)
);

-- Cadastros
create table addresses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  street text,
  number text,
  complement text,
  district text,
  city text,
  state text,
  postal_code text,
  country text default 'BR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  person_type person_type not null,
  name text not null,
  legal_name text,
  cpf_cnpj text,
  ie text,
  email text,
  phone text,
  address_id uuid references addresses(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  person_type person_type not null,
  name text not null,
  legal_name text,
  cpf_cnpj text,
  ie text,
  email text,
  phone text,
  address_id uuid references addresses(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sku text,
  name text not null,
  description text,
  product_type product_type not null default 'product',
  ncm text,
  cest text,
  uom text not null default 'UN',
  price numeric(18,2) not null default 0,
  cost numeric(18,2) not null default 0,
  is_kit boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, sku)
);

create table product_kits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (organization_id, product_id)
);

create table product_kit_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kit_id uuid not null references product_kits(id) on delete cascade,
  component_product_id uuid not null references products(id),
  quantity numeric(18,4) not null default 1
);

-- Estoque
create table warehouses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  address_id uuid references addresses(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table product_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid not null references products(id),
  batch_code text not null,
  expiration_date date,
  created_at timestamptz not null default now(),
  unique (organization_id, product_id, batch_code)
);

create table stock_levels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid not null references products(id),
  warehouse_id uuid not null references warehouses(id),
  batch_id uuid references product_batches(id),
  qty_available numeric(18,4) not null default 0,
  qty_reserved numeric(18,4) not null default 0,
  min_qty numeric(18,4) not null default 0,
  max_qty numeric(18,4) not null default 0,
  updated_at timestamptz not null default now(),
  unique (organization_id, product_id, warehouse_id, batch_id)
);

create unique index stock_levels_unique_null_batch_idx
  on stock_levels (organization_id, product_id, warehouse_id)
  where batch_id is null;

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid not null references products(id),
  warehouse_id uuid not null references warehouses(id),
  batch_id uuid references product_batches(id),
  movement_type stock_movement_type not null,
  quantity numeric(18,4) not null,
  unit_cost numeric(18,2),
  reason text,
  ref_table text,
  ref_id uuid,
  occurred_at timestamptz not null default now()
);

-- Compras e recebimentos
create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_id uuid references suppliers(id),
  warehouse_id uuid references warehouses(id),
  status purchase_order_status not null default 'draft',
  total_amount numeric(18,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_cost numeric(18,2) not null default 0,
  total_cost numeric(18,2) not null default 0
);

create table purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_order_id uuid references purchase_orders(id),
  supplier_id uuid references suppliers(id),
  warehouse_id uuid references warehouses(id),
  status purchase_receipt_status not null default 'pending',
  total_amount numeric(18,2) not null default 0,
  notes text,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table purchase_receipt_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_receipt_id uuid not null references purchase_receipts(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_cost numeric(18,2) not null default 0,
  total_cost numeric(18,2) not null default 0
);

-- Transferencia entre estoques
create table stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  origin_warehouse_id uuid not null references warehouses(id),
  destination_warehouse_id uuid not null references warehouses(id),
  status stock_transfer_status not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  transfer_id uuid not null references stock_transfers(id) on delete cascade,
  product_id uuid not null references products(id),
  quantity numeric(18,4) not null default 1
);

-- Fiscal: perfis e regras
create table fiscal_tax_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  profile_type tax_profile_type not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table fiscal_tax_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  profile_id uuid not null references fiscal_tax_profiles(id) on delete cascade,
  tax_type tax_type not null,
  origin_state text,
  destination_state text,
  cfop text,
  cst text,
  csosn text,
  rate numeric(10,4) not null default 0,
  base_reduction numeric(10,4) not null default 0,
  st_margin numeric(10,4) not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

-- Comercial: orcamentos, pedidos e faturamento
create table quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  status text not null default 'draft',
  total_amount numeric(18,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table quote_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  quote_id uuid not null references quotes(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_price numeric(18,2) not null default 0,
  total_price numeric(18,2) not null default 0
);

create table sales_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  quote_id uuid references quotes(id),
  warehouse_id uuid references warehouses(id),
  sales_agent_id uuid references sales_agents(id),
  status text not null default 'open',
  total_amount numeric(18,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sales_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sales_order_id uuid not null references sales_orders(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_price numeric(18,2) not null default 0,
  total_price numeric(18,2) not null default 0,
  ncm text,
  cfop text
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sales_order_id uuid references sales_orders(id),
  customer_id uuid references customers(id),
  origin invoice_origin not null default 'sales_order',
  total_amount numeric(18,2) not null default 0,
  status text not null default 'open',
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fiscal: documentos e eventos
create table fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  invoice_id uuid references invoices(id),
  emitter_id uuid references fiscal_emitters(id) on delete set null,
  doc_type document_type not null,
  status document_status not null default 'draft',
  environment document_environment not null default 'homologation',
  model smallint,
  series int,
  number int,
  access_key text,
  issue_date timestamptz,
  total_products numeric(18,2) not null default 0,
  total_taxes numeric(18,2) not null default 0,
  total_invoice numeric(18,2) not null default 0,
  xml text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, doc_type, series, number),
  unique (organization_id, access_key)
);

create index fiscal_documents_org_emitter_idx
  on fiscal_documents (organization_id, emitter_id);

create table fiscal_document_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_price numeric(18,2) not null default 0,
  total_price numeric(18,2) not null default 0,
  ncm text,
  cfop text,
  uom text
);

create table fiscal_document_parties (
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

create table fiscal_tax_calculations (
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

create table fiscal_tax_lines (
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

create table fiscal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  event_type fiscal_event_type not null,
  protocol text,
  xml text,
  created_at timestamptz not null default now()
);

-- Importacao inteligente de XML
create table xml_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_id uuid references suppliers(id),
  status text not null default 'pending',
  raw_xml text not null,
  created_at timestamptz not null default now()
);

create table xml_import_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  xml_import_id uuid not null references xml_imports(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_cost numeric(18,2) not null default 0
);

-- Servicos e OS
create table technicians (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table service_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  vehicle_id uuid references vehicles(id),
  status service_order_status not null default 'open',
  total_amount numeric(18,2) not null default 0,
  notes text,
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table service_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service_order_id uuid not null references service_orders(id) on delete cascade,
  product_id uuid references products(id),
  description text,
  quantity numeric(18,4) not null default 1,
  unit_price numeric(18,2) not null default 0,
  total_price numeric(18,2) not null default 0,
  hours_worked numeric(10,2) not null default 0
);

create table service_checklists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service_order_id uuid not null references service_orders(id) on delete cascade,
  item text not null,
  is_done boolean not null default false
);

create table service_order_technicians (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service_order_id uuid not null references service_orders(id) on delete cascade,
  technician_id uuid not null references technicians(id),
  hours_worked numeric(10,2) not null default 0
);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  plate text,
  brand text,
  model text,
  year int,
  color text,
  vin text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table service_time_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service_order_id uuid not null references service_orders(id) on delete cascade,
  technician_id uuid references technicians(id),
  entry_type service_time_entry_type not null default 'labor',
  hours numeric(10,2) not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

-- CRM / Agenda / Pos-venda
create table appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  subject text not null,
  scheduled_at timestamptz not null,
  status appointment_status not null default 'scheduled',
  notes text,
  created_at timestamptz not null default now()
);

create table call_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  phone text,
  outcome text,
  notes text,
  occurred_at timestamptz not null default now()
);

create table marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  channel text,
  status campaign_status not null default 'draft',
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create table campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid not null references marketing_campaigns(id) on delete cascade,
  customer_id uuid references customers(id),
  email text,
  phone text,
  created_at timestamptz not null default now()
);

-- Promocoes
create table promotions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid references products(id),
  name text not null,
  promo_price numeric(18,2) not null,
  start_at timestamptz,
  end_at timestamptz,
  status promotion_status not null default 'scheduled',
  created_at timestamptz not null default now()
);

-- Inventarios (contagem)
create table inventory_counts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  warehouse_id uuid references warehouses(id),
  status inventory_count_status not null default 'draft',
  counted_at timestamptz,
  created_at timestamptz not null default now()
);

create table inventory_count_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  count_id uuid not null references inventory_counts(id) on delete cascade,
  product_id uuid references products(id),
  expected_qty numeric(18,4) not null default 0,
  counted_qty numeric(18,4) not null default 0
);

-- Troca/Devolucao
create table return_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  status return_status not null default 'requested',
  reason text,
  created_at timestamptz not null default now()
);

create table return_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  return_order_id uuid not null references return_orders(id) on delete cascade,
  product_id uuid references products(id),
  quantity numeric(18,4) not null default 1,
  condition text
);

-- Expedição / Entrega
create table shipments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sales_order_id uuid references sales_orders(id),
  customer_id uuid references customers(id),
  type shipment_type not null default 'delivery',
  status shipment_status not null default 'pending',
  carrier text,
  tracking_code text,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create table shipment_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  shipment_id uuid not null references shipments(id) on delete cascade,
  product_id uuid references products(id),
  quantity numeric(18,4) not null default 1
);

-- Funcionarios / Comissao
create table employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  status employee_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sales_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_id uuid references employees(id),
  name text not null,
  commission_rate numeric(10,4) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table sales_commissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sales_order_id uuid references sales_orders(id),
  agent_id uuid references sales_agents(id),
  amount numeric(18,2) not null default 0,
  status commission_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- Emprestimo de mercadoria
create table loan_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  status loan_status not null default 'open',
  expected_return_date date,
  returned_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table loan_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  loan_order_id uuid not null references loan_orders(id) on delete cascade,
  product_id uuid references products(id),
  quantity numeric(18,4) not null default 1
);

-- Integração bancária (OFX)
create table ofx_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  account_id uuid references financial_accounts(id),
  status ofx_import_status not null default 'pending',
  raw_text text not null,
  created_at timestamptz not null default now()
);

create table ofx_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  import_id uuid not null references ofx_imports(id) on delete cascade,
  account_id uuid references financial_accounts(id),
  fit_id text,
  posted_at timestamptz,
  amount numeric(18,2) not null,
  memo text,
  name text,
  created_at timestamptz not null default now()
);

-- Etiquetas
create table labels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid references products(id),
  quantity int not null default 1,
  payload jsonb,
  status label_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- Integração bancária (estrutura)
create table bank_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider bank_provider not null,
  name text,
  config jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table bank_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  integration_id uuid references bank_integrations(id),
  event_type text not null,
  payload jsonb not null,
  status bank_webhook_status not null default 'received',
  created_at timestamptz not null default now()
);

-- PIX/Boleto (estrutura)
create table payment_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_id uuid references financial_titles(id),
  provider bank_provider not null,
  amount numeric(18,2) not null,
  status payment_request_status not null default 'created',
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Cheques / Cartoes (estrutura)
create table cheque_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_id uuid references financial_titles(id),
  bank text,
  agency text,
  account text,
  cheque_number text,
  due_date date,
  amount numeric(18,2) not null,
  status cheque_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table card_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_id uuid references financial_titles(id),
  brand text,
  holder_name text,
  last4 text,
  installments int not null default 1,
  amount numeric(18,2) not null,
  status text not null default 'authorized',
  created_at timestamptz not null default now()
);

-- Transmissão fiscal (fila/estado)
create table fiscal_transmissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  status fiscal_transmission_status not null default 'queued',
  provider fiscal_provider,
  provider_reference text,
  request_payload jsonb,
  response_payload jsonb,
  response_code text,
  response_message text,
  sent_at timestamptz,
  authorized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index fiscal_transmissions_active_document_idx
  on fiscal_transmissions (organization_id, document_id)
  where status in ('queued', 'sent');

create index fiscal_transmissions_org_doc_updated_idx
  on fiscal_transmissions (organization_id, document_id, updated_at desc);

-- Sintegra (estrutura)
create table sintegra_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status sintegra_status not null default 'draft',
  generated_at timestamptz,
  file_text text,
  created_at timestamptz not null default now()
);

-- Recorrencia
create table contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id),
  status contract_status not null default 'active',
  start_date date not null,
  end_date date,
  billing_day int not null default 1,
  created_at timestamptz not null default now()
);

create table contract_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contract_id uuid not null references contracts(id) on delete cascade,
  description text not null,
  quantity numeric(18,4) not null default 1,
  unit_price numeric(18,2) not null default 0
);

-- Financeiro
create table financial_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  bank_code text,
  agency text,
  account_number text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table financial_titles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_type financial_title_type not null,
  customer_id uuid references customers(id),
  supplier_id uuid references suppliers(id),
  invoice_id uuid references invoices(id),
  description text,
  total_amount numeric(18,2) not null,
  status financial_status not null default 'open',
  created_at timestamptz not null default now()
);

create table financial_installments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_id uuid not null references financial_titles(id) on delete cascade,
  due_date date not null,
  amount numeric(18,2) not null,
  paid_at timestamptz,
  status financial_status not null default 'open'
);

create table cash_flow_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  account_id uuid references financial_accounts(id),
  title_id uuid references financial_titles(id),
  entry_date date not null,
  amount numeric(18,2) not null,
  description text,
  created_at timestamptz not null default now()
);

create table bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  account_id uuid references financial_accounts(id),
  ofx_reference text,
  created_at timestamptz not null default now()
);

create table bank_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  account_id uuid references financial_accounts(id),
  direction bank_tx_direction not null,
  amount numeric(18,2) not null,
  description text,
  external_ref text,
  occurred_at timestamptz not null default now(),
  status bank_tx_status not null default 'pending',
  created_at timestamptz not null default now()
);

create table bank_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  reconciliation_id uuid not null references bank_reconciliations(id) on delete cascade,
  bank_transaction_id uuid not null references bank_transactions(id) on delete cascade,
  installment_id uuid references financial_installments(id),
  created_at timestamptz not null default now(),
  unique (organization_id, bank_transaction_id)
);

-- Pagamentos e gateway
create table payment_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title_id uuid references financial_titles(id),
  method payment_method not null,
  amount numeric(18,2) not null,
  status text not null default 'pending',
  external_id text,
  created_at timestamptz not null default now()
);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  event_type text not null,
  payload jsonb not null,
  status webhook_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- PDV
create table pos_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  cashier_id uuid references auth.users(id),
  status pos_session_status not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create table pos_sales (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  pos_session_id uuid references pos_sessions(id),
  customer_id uuid references customers(id),
  total_amount numeric(18,2) not null default 0,
  created_at timestamptz not null default now()
);

create table pos_sale_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  pos_sale_id uuid not null references pos_sales(id) on delete cascade,
  product_id uuid references products(id),
  quantity numeric(18,4) not null default 1,
  unit_price numeric(18,2) not null default 0,
  total_price numeric(18,2) not null default 0
);

create table pos_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  pos_sale_id uuid not null references pos_sales(id) on delete cascade,
  method payment_method not null,
  amount numeric(18,2) not null,
  status pos_payment_status not null default 'paid'
);

-- Compliance e contingencia
create table compliance_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  context text not null,
  passed boolean not null,
  details text,
  created_at timestamptz not null default now()
);

create table contingency_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service_name text not null,
  status text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  details text
);

-- Triggers de updated_at
create trigger organizations_updated_at before update on organizations
for each row execute function set_updated_at();
create trigger profiles_updated_at before update on profiles
for each row execute function set_updated_at();
create trigger vault_certificates_updated_at before update on vault_certificates
for each row execute function set_updated_at();
create trigger addresses_updated_at before update on addresses
for each row execute function set_updated_at();
create trigger customers_updated_at before update on customers
for each row execute function set_updated_at();
create trigger suppliers_updated_at before update on suppliers
for each row execute function set_updated_at();
create trigger products_updated_at before update on products
for each row execute function set_updated_at();
create trigger warehouses_updated_at before update on warehouses
for each row execute function set_updated_at();
create trigger stock_levels_updated_at before update on stock_levels
for each row execute function set_updated_at();
create trigger purchase_orders_updated_at before update on purchase_orders
for each row execute function set_updated_at();
create trigger purchase_receipts_updated_at before update on purchase_receipts
for each row execute function set_updated_at();
create trigger stock_transfers_updated_at before update on stock_transfers
for each row execute function set_updated_at();
create trigger fiscal_tax_profiles_updated_at before update on fiscal_tax_profiles
for each row execute function set_updated_at();
create trigger fiscal_emitters_updated_at before update on fiscal_emitters
for each row execute function set_updated_at();
create trigger fiscal_provider_configs_updated_at before update on fiscal_provider_configs
for each row execute function set_updated_at();
create trigger fiscal_transmissions_updated_at before update on fiscal_transmissions
for each row execute function set_updated_at();
create trigger quotes_updated_at before update on quotes
for each row execute function set_updated_at();
create trigger sales_orders_updated_at before update on sales_orders
for each row execute function set_updated_at();
create trigger invoices_updated_at before update on invoices
for each row execute function set_updated_at();
create trigger fiscal_documents_updated_at before update on fiscal_documents
for each row execute function set_updated_at();
create trigger service_orders_updated_at before update on service_orders
for each row execute function set_updated_at();
create trigger vehicles_updated_at before update on vehicles
for each row execute function set_updated_at();

-- RLS
alter table organizations enable row level security;
alter table profiles enable row level security;
alter table organization_users enable row level security;
alter table audit_log enable row level security;
alter table vault_certificates enable row level security;
alter table addresses enable row level security;
alter table customers enable row level security;
alter table suppliers enable row level security;
alter table products enable row level security;
alter table product_kits enable row level security;
alter table product_kit_items enable row level security;
alter table warehouses enable row level security;
alter table product_batches enable row level security;
alter table stock_levels enable row level security;
alter table stock_movements enable row level security;
alter table purchase_orders enable row level security;
alter table purchase_order_items enable row level security;
alter table purchase_receipts enable row level security;
alter table purchase_receipt_items enable row level security;
alter table stock_transfers enable row level security;
alter table stock_transfer_items enable row level security;
alter table fiscal_tax_profiles enable row level security;
alter table fiscal_tax_rules enable row level security;
alter table fiscal_emitters enable row level security;
alter table fiscal_provider_configs enable row level security;
alter table quotes enable row level security;
alter table quote_items enable row level security;
alter table sales_orders enable row level security;
alter table sales_order_items enable row level security;
alter table invoices enable row level security;
alter table fiscal_documents enable row level security;
alter table fiscal_document_items enable row level security;
alter table fiscal_document_parties enable row level security;
alter table fiscal_tax_calculations enable row level security;
alter table fiscal_tax_lines enable row level security;
alter table fiscal_events enable row level security;
alter table xml_imports enable row level security;
alter table xml_import_items enable row level security;
alter table technicians enable row level security;
alter table vehicles enable row level security;
alter table service_orders enable row level security;
alter table service_order_items enable row level security;
alter table service_checklists enable row level security;
alter table service_order_technicians enable row level security;
alter table service_time_entries enable row level security;
alter table appointments enable row level security;
alter table call_logs enable row level security;
alter table marketing_campaigns enable row level security;
alter table campaign_contacts enable row level security;
alter table promotions enable row level security;
alter table inventory_counts enable row level security;
alter table inventory_count_items enable row level security;
alter table return_orders enable row level security;
alter table return_items enable row level security;
alter table shipments enable row level security;
alter table shipment_items enable row level security;
alter table employees enable row level security;
alter table sales_agents enable row level security;
alter table sales_commissions enable row level security;
alter table loan_orders enable row level security;
alter table loan_items enable row level security;
alter table ofx_imports enable row level security;
alter table ofx_transactions enable row level security;
alter table labels enable row level security;
alter table bank_integrations enable row level security;
alter table bank_webhook_events enable row level security;
alter table sintegra_exports enable row level security;
alter table payment_requests enable row level security;
alter table fiscal_transmissions enable row level security;
alter table cheque_payments enable row level security;
alter table card_payments enable row level security;
alter table contracts enable row level security;
alter table contract_items enable row level security;
alter table financial_accounts enable row level security;
alter table financial_titles enable row level security;
alter table financial_installments enable row level security;
alter table cash_flow_entries enable row level security;
alter table bank_reconciliations enable row level security;
alter table bank_transactions enable row level security;
alter table bank_reconciliation_items enable row level security;
alter table payment_transactions enable row level security;
alter table webhook_events enable row level security;
alter table pos_sessions enable row level security;
alter table pos_sales enable row level security;
alter table pos_sale_items enable row level security;
alter table pos_payments enable row level security;
alter table compliance_checks enable row level security;
alter table contingency_events enable row level security;

-- Policies
create policy organizations_select on organizations
for select using (
  exists (
    select 1 from organization_users ou
    where ou.organization_id = id and ou.user_id = auth.uid()
  )
);

create policy profiles_select on profiles
for select using (id = auth.uid());
create policy profiles_update on profiles
for update using (id = auth.uid()) with check (id = auth.uid());

create policy org_users_select on organization_users
for select using (user_id = auth.uid() or is_org_member(organization_id));
create policy org_users_insert on organization_users
for insert with check (is_org_member(organization_id));
create policy org_users_update on organization_users
for update using (is_org_member(organization_id)) with check (is_org_member(organization_id));
create policy org_users_delete on organization_users
for delete using (is_org_member(organization_id));

create policy audit_log_select on audit_log
for select using (has_org_access(organization_id));
create policy audit_log_insert on audit_log
for insert with check (has_org_access(organization_id));

-- Padrao para tabelas multi-tenant
create policy tenant_select on vault_certificates
for select using (has_org_access(organization_id));
create policy tenant_insert on vault_certificates
for insert with check (has_org_access(organization_id));
create policy tenant_update on vault_certificates
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on vault_certificates
for delete using (has_org_access(organization_id));

create policy tenant_select on addresses
for select using (has_org_access(organization_id));
create policy tenant_insert on addresses
for insert with check (has_org_access(organization_id));
create policy tenant_update on addresses
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on addresses
for delete using (has_org_access(organization_id));

create policy tenant_select on customers
for select using (has_org_access(organization_id));
create policy tenant_insert on customers
for insert with check (has_org_access(organization_id));
create policy tenant_update on customers
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on customers
for delete using (has_org_access(organization_id));

create policy tenant_select on suppliers
for select using (has_org_access(organization_id));
create policy tenant_insert on suppliers
for insert with check (has_org_access(organization_id));
create policy tenant_update on suppliers
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on suppliers
for delete using (has_org_access(organization_id));

create policy tenant_select on products
for select using (has_org_access(organization_id));
create policy tenant_insert on products
for insert with check (has_org_access(organization_id));
create policy tenant_update on products
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on products
for delete using (has_org_access(organization_id));

create policy tenant_select on product_kits
for select using (has_org_access(organization_id));
create policy tenant_insert on product_kits
for insert with check (has_org_access(organization_id));
create policy tenant_update on product_kits
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on product_kits
for delete using (has_org_access(organization_id));

create policy tenant_select on product_kit_items
for select using (has_org_access(organization_id));
create policy tenant_insert on product_kit_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on product_kit_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on product_kit_items
for delete using (has_org_access(organization_id));

create policy tenant_select on warehouses
for select using (has_org_access(organization_id));
create policy tenant_insert on warehouses
for insert with check (has_org_access(organization_id));
create policy tenant_update on warehouses
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on warehouses
for delete using (has_org_access(organization_id));

create policy tenant_select on product_batches
for select using (has_org_access(organization_id));
create policy tenant_insert on product_batches
for insert with check (has_org_access(organization_id));
create policy tenant_update on product_batches
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on product_batches
for delete using (has_org_access(organization_id));

create policy tenant_select on stock_levels
for select using (has_org_access(organization_id));
create policy tenant_insert on stock_levels
for insert with check (has_org_access(organization_id));
create policy tenant_update on stock_levels
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on stock_levels
for delete using (has_org_access(organization_id));

create policy tenant_select on stock_movements
for select using (has_org_access(organization_id));
create policy tenant_insert on stock_movements
for insert with check (has_org_access(organization_id));
create policy tenant_update on stock_movements
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on stock_movements
for delete using (has_org_access(organization_id));

create policy tenant_select on purchase_orders
for select using (has_org_access(organization_id));
create policy tenant_insert on purchase_orders
for insert with check (has_org_access(organization_id));
create policy tenant_update on purchase_orders
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on purchase_orders
for delete using (has_org_access(organization_id));

create policy tenant_select on purchase_order_items
for select using (has_org_access(organization_id));
create policy tenant_insert on purchase_order_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on purchase_order_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on purchase_order_items
for delete using (has_org_access(organization_id));

create policy tenant_select on purchase_receipts
for select using (has_org_access(organization_id));
create policy tenant_insert on purchase_receipts
for insert with check (has_org_access(organization_id));
create policy tenant_update on purchase_receipts
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on purchase_receipts
for delete using (has_org_access(organization_id));

create policy tenant_select on purchase_receipt_items
for select using (has_org_access(organization_id));
create policy tenant_insert on purchase_receipt_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on purchase_receipt_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on purchase_receipt_items
for delete using (has_org_access(organization_id));

create policy tenant_select on stock_transfers
for select using (has_org_access(organization_id));
create policy tenant_insert on stock_transfers
for insert with check (has_org_access(organization_id));
create policy tenant_update on stock_transfers
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on stock_transfers
for delete using (has_org_access(organization_id));

create policy tenant_select on stock_transfer_items
for select using (has_org_access(organization_id));
create policy tenant_insert on stock_transfer_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on stock_transfer_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on stock_transfer_items
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_tax_profiles
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_tax_profiles
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_tax_profiles
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_tax_profiles
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_tax_rules
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_tax_rules
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_tax_rules
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_tax_rules
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_emitters
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_emitters
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_emitters
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_emitters
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_provider_configs
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_provider_configs
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_provider_configs
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_provider_configs
for delete using (has_org_access(organization_id));

create policy tenant_select on quotes
for select using (has_org_access(organization_id));
create policy tenant_insert on quotes
for insert with check (has_org_access(organization_id));
create policy tenant_update on quotes
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on quotes
for delete using (has_org_access(organization_id));

create policy tenant_select on quote_items
for select using (has_org_access(organization_id));
create policy tenant_insert on quote_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on quote_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on quote_items
for delete using (has_org_access(organization_id));

create policy tenant_select on sales_orders
for select using (has_org_access(organization_id));
create policy tenant_insert on sales_orders
for insert with check (has_org_access(organization_id));
create policy tenant_update on sales_orders
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on sales_orders
for delete using (has_org_access(organization_id));

create policy tenant_select on sales_order_items
for select using (has_org_access(organization_id));
create policy tenant_insert on sales_order_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on sales_order_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on sales_order_items
for delete using (has_org_access(organization_id));

create policy tenant_select on invoices
for select using (has_org_access(organization_id));
create policy tenant_insert on invoices
for insert with check (has_org_access(organization_id));
create policy tenant_update on invoices
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on invoices
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_documents
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_documents
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_documents
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_documents
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_document_items
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_document_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_document_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_document_items
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_document_parties
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_document_parties
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_document_parties
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_document_parties
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_tax_calculations
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_tax_calculations
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_tax_calculations
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_tax_calculations
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_tax_lines
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_tax_lines
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_tax_lines
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_tax_lines
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_events
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_events
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_events
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_events
for delete using (has_org_access(organization_id));

create policy tenant_select on xml_imports
for select using (has_org_access(organization_id));
create policy tenant_insert on xml_imports
for insert with check (has_org_access(organization_id));
create policy tenant_update on xml_imports
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on xml_imports
for delete using (has_org_access(organization_id));

create policy tenant_select on xml_import_items
for select using (has_org_access(organization_id));
create policy tenant_insert on xml_import_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on xml_import_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on xml_import_items
for delete using (has_org_access(organization_id));

create policy tenant_select on technicians
for select using (has_org_access(organization_id));
create policy tenant_insert on technicians
for insert with check (has_org_access(organization_id));
create policy tenant_update on technicians
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on technicians
for delete using (has_org_access(organization_id));

create policy tenant_select on vehicles
for select using (has_org_access(organization_id));
create policy tenant_insert on vehicles
for insert with check (has_org_access(organization_id));
create policy tenant_update on vehicles
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on vehicles
for delete using (has_org_access(organization_id));

create policy tenant_select on service_orders
for select using (has_org_access(organization_id));
create policy tenant_insert on service_orders
for insert with check (has_org_access(organization_id));
create policy tenant_update on service_orders
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on service_orders
for delete using (has_org_access(organization_id));

create policy tenant_select on service_order_items
for select using (has_org_access(organization_id));
create policy tenant_insert on service_order_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on service_order_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on service_order_items
for delete using (has_org_access(organization_id));

create policy tenant_select on service_checklists
for select using (has_org_access(organization_id));
create policy tenant_insert on service_checklists
for insert with check (has_org_access(organization_id));
create policy tenant_update on service_checklists
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on service_checklists
for delete using (has_org_access(organization_id));

create policy tenant_select on service_order_technicians
for select using (has_org_access(organization_id));
create policy tenant_insert on service_order_technicians
for insert with check (has_org_access(organization_id));
create policy tenant_update on service_order_technicians
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on service_order_technicians
for delete using (has_org_access(organization_id));

create policy tenant_select on service_time_entries
for select using (has_org_access(organization_id));
create policy tenant_insert on service_time_entries
for insert with check (has_org_access(organization_id));
create policy tenant_update on service_time_entries
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on service_time_entries
for delete using (has_org_access(organization_id));

create policy tenant_select on appointments
for select using (has_org_access(organization_id));
create policy tenant_insert on appointments
for insert with check (has_org_access(organization_id));
create policy tenant_update on appointments
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on appointments
for delete using (has_org_access(organization_id));

create policy tenant_select on call_logs
for select using (has_org_access(organization_id));
create policy tenant_insert on call_logs
for insert with check (has_org_access(organization_id));
create policy tenant_update on call_logs
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on call_logs
for delete using (has_org_access(organization_id));

create policy tenant_select on marketing_campaigns
for select using (has_org_access(organization_id));
create policy tenant_insert on marketing_campaigns
for insert with check (has_org_access(organization_id));
create policy tenant_update on marketing_campaigns
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on marketing_campaigns
for delete using (has_org_access(organization_id));

create policy tenant_select on campaign_contacts
for select using (has_org_access(organization_id));
create policy tenant_insert on campaign_contacts
for insert with check (has_org_access(organization_id));
create policy tenant_update on campaign_contacts
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on campaign_contacts
for delete using (has_org_access(organization_id));

create policy tenant_select on promotions
for select using (has_org_access(organization_id));
create policy tenant_insert on promotions
for insert with check (has_org_access(organization_id));
create policy tenant_update on promotions
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on promotions
for delete using (has_org_access(organization_id));

create policy tenant_select on inventory_counts
for select using (has_org_access(organization_id));
create policy tenant_insert on inventory_counts
for insert with check (has_org_access(organization_id));
create policy tenant_update on inventory_counts
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on inventory_counts
for delete using (has_org_access(organization_id));

create policy tenant_select on inventory_count_items
for select using (has_org_access(organization_id));
create policy tenant_insert on inventory_count_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on inventory_count_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on inventory_count_items
for delete using (has_org_access(organization_id));

create policy tenant_select on return_orders
for select using (has_org_access(organization_id));
create policy tenant_insert on return_orders
for insert with check (has_org_access(organization_id));
create policy tenant_update on return_orders
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on return_orders
for delete using (has_org_access(organization_id));

create policy tenant_select on return_items
for select using (has_org_access(organization_id));
create policy tenant_insert on return_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on return_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on return_items
for delete using (has_org_access(organization_id));

create policy tenant_select on shipments
for select using (has_org_access(organization_id));
create policy tenant_insert on shipments
for insert with check (has_org_access(organization_id));
create policy tenant_update on shipments
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on shipments
for delete using (has_org_access(organization_id));

create policy tenant_select on shipment_items
for select using (has_org_access(organization_id));
create policy tenant_insert on shipment_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on shipment_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on shipment_items
for delete using (has_org_access(organization_id));

create policy tenant_select on employees
for select using (has_org_access(organization_id));
create policy tenant_insert on employees
for insert with check (has_org_access(organization_id));
create policy tenant_update on employees
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on employees
for delete using (has_org_access(organization_id));

create policy tenant_select on sales_agents
for select using (has_org_access(organization_id));
create policy tenant_insert on sales_agents
for insert with check (has_org_access(organization_id));
create policy tenant_update on sales_agents
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on sales_agents
for delete using (has_org_access(organization_id));

create policy tenant_select on sales_commissions
for select using (has_org_access(organization_id));
create policy tenant_insert on sales_commissions
for insert with check (has_org_access(organization_id));
create policy tenant_update on sales_commissions
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on sales_commissions
for delete using (has_org_access(organization_id));

create policy tenant_select on loan_orders
for select using (has_org_access(organization_id));
create policy tenant_insert on loan_orders
for insert with check (has_org_access(organization_id));
create policy tenant_update on loan_orders
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on loan_orders
for delete using (has_org_access(organization_id));

create policy tenant_select on loan_items
for select using (has_org_access(organization_id));
create policy tenant_insert on loan_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on loan_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on loan_items
for delete using (has_org_access(organization_id));

create policy tenant_select on ofx_imports
for select using (has_org_access(organization_id));
create policy tenant_insert on ofx_imports
for insert with check (has_org_access(organization_id));
create policy tenant_update on ofx_imports
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on ofx_imports
for delete using (has_org_access(organization_id));

create policy tenant_select on ofx_transactions
for select using (has_org_access(organization_id));
create policy tenant_insert on ofx_transactions
for insert with check (has_org_access(organization_id));
create policy tenant_update on ofx_transactions
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on ofx_transactions
for delete using (has_org_access(organization_id));

create policy tenant_select on labels
for select using (has_org_access(organization_id));
create policy tenant_insert on labels
for insert with check (has_org_access(organization_id));
create policy tenant_update on labels
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on labels
for delete using (has_org_access(organization_id));

create policy tenant_select on bank_integrations
for select using (has_org_access(organization_id));
create policy tenant_insert on bank_integrations
for insert with check (has_org_access(organization_id));
create policy tenant_update on bank_integrations
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on bank_integrations
for delete using (has_org_access(organization_id));

create policy tenant_select on bank_webhook_events
for select using (has_org_access(organization_id));
create policy tenant_insert on bank_webhook_events
for insert with check (has_org_access(organization_id));
create policy tenant_update on bank_webhook_events
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on bank_webhook_events
for delete using (has_org_access(organization_id));

create policy tenant_select on sintegra_exports
for select using (has_org_access(organization_id));
create policy tenant_insert on sintegra_exports
for insert with check (has_org_access(organization_id));
create policy tenant_update on sintegra_exports
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on sintegra_exports
for delete using (has_org_access(organization_id));

create policy tenant_select on payment_requests
for select using (has_org_access(organization_id));
create policy tenant_insert on payment_requests
for insert with check (has_org_access(organization_id));
create policy tenant_update on payment_requests
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on payment_requests
for delete using (has_org_access(organization_id));

create policy tenant_select on fiscal_transmissions
for select using (has_org_access(organization_id));
create policy tenant_insert on fiscal_transmissions
for insert with check (has_org_access(organization_id));
create policy tenant_update on fiscal_transmissions
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on fiscal_transmissions
for delete using (has_org_access(organization_id));

create policy tenant_select on cheque_payments
for select using (has_org_access(organization_id));
create policy tenant_insert on cheque_payments
for insert with check (has_org_access(organization_id));
create policy tenant_update on cheque_payments
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on cheque_payments
for delete using (has_org_access(organization_id));

create policy tenant_select on card_payments
for select using (has_org_access(organization_id));
create policy tenant_insert on card_payments
for insert with check (has_org_access(organization_id));
create policy tenant_update on card_payments
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on card_payments
for delete using (has_org_access(organization_id));

create policy tenant_select on contracts
for select using (has_org_access(organization_id));
create policy tenant_insert on contracts
for insert with check (has_org_access(organization_id));
create policy tenant_update on contracts
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on contracts
for delete using (has_org_access(organization_id));

create policy tenant_select on contract_items
for select using (has_org_access(organization_id));
create policy tenant_insert on contract_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on contract_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on contract_items
for delete using (has_org_access(organization_id));

create policy tenant_select on financial_accounts
for select using (has_org_access(organization_id));
create policy tenant_insert on financial_accounts
for insert with check (has_org_access(organization_id));
create policy tenant_update on financial_accounts
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on financial_accounts
for delete using (has_org_access(organization_id));

create policy tenant_select on financial_titles
for select using (has_org_access(organization_id));
create policy tenant_insert on financial_titles
for insert with check (has_org_access(organization_id));
create policy tenant_update on financial_titles
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on financial_titles
for delete using (has_org_access(organization_id));

create policy tenant_select on financial_installments
for select using (has_org_access(organization_id));
create policy tenant_insert on financial_installments
for insert with check (has_org_access(organization_id));
create policy tenant_update on financial_installments
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on financial_installments
for delete using (has_org_access(organization_id));

create policy tenant_select on cash_flow_entries
for select using (has_org_access(organization_id));
create policy tenant_insert on cash_flow_entries
for insert with check (has_org_access(organization_id));
create policy tenant_update on cash_flow_entries
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on cash_flow_entries
for delete using (has_org_access(organization_id));

create policy tenant_select on bank_reconciliations
for select using (has_org_access(organization_id));
create policy tenant_insert on bank_reconciliations
for insert with check (has_org_access(organization_id));
create policy tenant_update on bank_reconciliations
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on bank_reconciliations
for delete using (has_org_access(organization_id));

create policy tenant_select on bank_transactions
for select using (has_org_access(organization_id));
create policy tenant_insert on bank_transactions
for insert with check (has_org_access(organization_id));
create policy tenant_update on bank_transactions
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on bank_transactions
for delete using (has_org_access(organization_id));

create policy tenant_select on bank_reconciliation_items
for select using (has_org_access(organization_id));
create policy tenant_insert on bank_reconciliation_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on bank_reconciliation_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on bank_reconciliation_items
for delete using (has_org_access(organization_id));

create policy tenant_select on payment_transactions
for select using (has_org_access(organization_id));
create policy tenant_insert on payment_transactions
for insert with check (has_org_access(organization_id));
create policy tenant_update on payment_transactions
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on payment_transactions
for delete using (has_org_access(organization_id));

create policy tenant_select on webhook_events
for select using (has_org_access(organization_id));
create policy tenant_insert on webhook_events
for insert with check (has_org_access(organization_id));
create policy tenant_update on webhook_events
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on webhook_events
for delete using (has_org_access(organization_id));

create policy tenant_select on pos_sessions
for select using (has_org_access(organization_id));
create policy tenant_insert on pos_sessions
for insert with check (has_org_access(organization_id));
create policy tenant_update on pos_sessions
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on pos_sessions
for delete using (has_org_access(organization_id));

create policy tenant_select on pos_sales
for select using (has_org_access(organization_id));
create policy tenant_insert on pos_sales
for insert with check (has_org_access(organization_id));
create policy tenant_update on pos_sales
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on pos_sales
for delete using (has_org_access(organization_id));

create policy tenant_select on pos_sale_items
for select using (has_org_access(organization_id));
create policy tenant_insert on pos_sale_items
for insert with check (has_org_access(organization_id));
create policy tenant_update on pos_sale_items
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on pos_sale_items
for delete using (has_org_access(organization_id));

create policy tenant_select on pos_payments
for select using (has_org_access(organization_id));
create policy tenant_insert on pos_payments
for insert with check (has_org_access(organization_id));
create policy tenant_update on pos_payments
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on pos_payments
for delete using (has_org_access(organization_id));

create policy tenant_select on compliance_checks
for select using (has_org_access(organization_id));
create policy tenant_insert on compliance_checks
for insert with check (has_org_access(organization_id));
create policy tenant_update on compliance_checks
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on compliance_checks
for delete using (has_org_access(organization_id));

create policy tenant_select on contingency_events
for select using (has_org_access(organization_id));
create policy tenant_insert on contingency_events
for insert with check (has_org_access(organization_id));
create policy tenant_update on contingency_events
for update using (has_org_access(organization_id)) with check (has_org_access(organization_id));
create policy tenant_delete on contingency_events
for delete using (has_org_access(organization_id));
