-- ============================================================================
-- VinteEnterprise ERP — Mega Expansion: 16 New Modules
-- ============================================================================
-- Modules: Fleet, MRP, Advanced Finance, WMS, Audit+, AI, BI/DW,
--          Comex, Assets, BPMN, QMS, Treasury, Portals, ESG, PSA, Franchises
-- ============================================================================

set search_path to public, extensions;

-- ============================================================================
-- MODULE 3: FINANCEIRO AVANÇADO
-- ============================================================================

-- Cost Centers
create table if not exists cost_centers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  name text not null,
  center_type text not null default 'cost' check (center_type in ('cost', 'profit')),
  parent_id uuid references cost_centers(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

-- Add cost_center_id to financial_titles
alter table financial_titles add column if not exists cost_center_id uuid references cost_centers(id);
alter table financial_titles add column if not exists competence_date date;

-- Add cost_center_id to cash_flow_entries
alter table cash_flow_entries add column if not exists cost_center_id uuid references cost_centers(id);

-- Add nosso_numero and paid_amount to financial_installments (needed for CNAB)
alter table financial_installments add column if not exists nosso_numero text;
alter table financial_installments add column if not exists paid_amount numeric(18,2);

-- Billing Rules (Régua de Cobrança)
create table if not exists billing_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  days_offset int not null, -- negative = before due, positive = after due
  channel text not null default 'email' check (channel in ('email', 'whatsapp', 'sms', 'internal')),
  template_subject text,
  template_body text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists billing_rule_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  rule_id uuid not null references billing_rules(id) on delete cascade,
  installment_id uuid not null references financial_installments(id) on delete cascade,
  sent_at timestamptz not null default now(),
  channel text not null,
  status text not null default 'sent' check (status in ('sent', 'delivered', 'failed', 'skipped')),
  error_message text
);

-- CNAB Return Processing
create table if not exists cnab_returns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  file_name text not null,
  bank_code text,
  format text not null default '240' check (format in ('240', '400')),
  total_entries int not null default 0,
  processed_count int not null default 0,
  error_count int not null default 0,
  processed_at timestamptz,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists cnab_return_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  return_id uuid not null references cnab_returns(id) on delete cascade,
  line_number int not null,
  nosso_numero text,
  valor_pago numeric(18,2),
  data_credito date,
  data_ocorrencia date,
  codigo_ocorrencia text,
  status text not null default 'pending' check (status in ('pending', 'matched', 'paid', 'error', 'protest')),
  installment_id uuid references financial_installments(id),
  error_message text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 5: AUDITORIA AVANÇADA
-- ============================================================================

-- Shadow Tables (field-level versioning)
create table if not exists record_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  table_name text not null,
  record_id uuid not null,
  version_number int not null default 1,
  old_data jsonb,
  new_data jsonb,
  changed_fields text[] not null default '{}',
  operation text not null check (operation in ('insert', 'update', 'delete')),
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_record_versions_lookup
  on record_versions (organization_id, table_name, record_id, created_at desc);

-- Approval Workflow (Alçadas)
create table if not exists approval_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  entity_type text not null, -- 'sales_order', 'purchase_order', 'financial_title', etc
  field_name text not null default 'total_amount',
  threshold numeric(18,2) not null,
  required_role text not null default 'chefe',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  rule_id uuid not null references approval_rules(id) on delete cascade,
  entity_type text not null,
  record_id uuid not null,
  field_value numeric(18,2) not null,
  requester_user_id uuid not null references auth.users(id),
  approver_user_id uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  approval_token text unique,
  notes text,
  decided_at timestamptz,
  expires_at timestamptz not null default (now() + interval '48 hours'),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 7: BI & DATA WAREHOUSE
-- ============================================================================

-- Daily Stock Snapshots
create table if not exists stock_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  snapshot_date date not null,
  product_id uuid not null references products(id) on delete cascade,
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  qty_available numeric(18,4) not null default 0,
  qty_reserved numeric(18,4) not null default 0,
  unit_cost numeric(18,4) not null default 0,
  total_value numeric(18,4) not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, snapshot_date, product_id, warehouse_id)
);

create index if not exists idx_stock_snapshots_date
  on stock_snapshots (organization_id, snapshot_date desc);

-- ============================================================================
-- MODULE 4: LOGÍSTICA & WMS
-- ============================================================================

-- Warehouse Locations (Endereçamento)
create table if not exists warehouse_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  aisle text not null, -- Rua
  shelf text not null, -- Prateleira
  level text not null, -- Nível
  code text not null, -- e.g. "A-01-03"
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, warehouse_id, code)
);

-- Add location to stock_levels
alter table stock_levels add column if not exists location_id uuid references warehouse_locations(id);

-- Add dimensions to products for cubage
alter table products add column if not exists weight_kg numeric(10,3);
alter table products add column if not exists width_cm numeric(10,2);
alter table products add column if not exists height_cm numeric(10,2);
alter table products add column if not exists depth_cm numeric(10,2);

-- Pick Lists
create table if not exists pick_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  shipment_id uuid references shipments(id),
  sales_order_id uuid references sales_orders(id),
  status text not null default 'pending' check (status in ('pending', 'picking', 'picked', 'packing', 'packed', 'cancelled')),
  created_by uuid references auth.users(id),
  picked_at timestamptz,
  packed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pick_list_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  pick_list_id uuid not null references pick_lists(id) on delete cascade,
  product_id uuid not null references products(id),
  location_id uuid references warehouse_locations(id),
  qty_expected numeric(18,4) not null,
  qty_picked numeric(18,4) not null default 0,
  barcode_scanned text,
  picked_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 1: GESTÃO DE FROTA (FLEET PRO)
-- ============================================================================

-- Extend vehicles table for fleet management
alter table vehicles add column if not exists km_current numeric(12,1) default 0;
alter table vehicles add column if not exists fleet_status text default 'active' check (fleet_status in ('active', 'maintenance', 'inactive', 'sold'));
alter table vehicles add column if not exists fuel_type text check (fuel_type in ('gasoline', 'ethanol', 'diesel', 'flex', 'electric', 'hybrid'));
alter table vehicles add column if not exists tank_liters numeric(6,1);
alter table vehicles add column if not exists insurance_expiry date;
alter table vehicles add column if not exists ipva_expiry date;

-- Fleet Tires
create table if not exists fleet_tires (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  position text not null, -- DE, DD, TE, TD, EE, ED, etc
  fire_number text, -- número de fogo
  tread_depth_mm numeric(5,2), -- sulcagem
  km_installed numeric(12,1),
  installed_at date,
  removed_at date,
  status text not null default 'active' check (status in ('active', 'worn', 'removed', 'retreaded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fleet Incidents (Sinistros)
create table if not exists fleet_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  incident_type text not null check (incident_type in ('accident', 'fine', 'theft', 'vandalism', 'mechanical', 'other')),
  incident_date date not null,
  description text,
  cost numeric(18,2) default 0,
  insurance_claim text,
  insurer text,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fleet Maintenance Plans
create table if not exists fleet_maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  name text not null,
  plan_type text not null check (plan_type in ('km', 'time', 'both')),
  interval_km numeric(12,1),
  interval_days int,
  last_km numeric(12,1),
  last_date date,
  next_km numeric(12,1),
  next_date date,
  auto_generate_os boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fleet Refueling
create table if not exists fleet_refueling (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  refueling_date date not null,
  km_current numeric(12,1) not null,
  liters numeric(10,3) not null,
  total_cost numeric(18,2) not null,
  fuel_type text,
  km_per_liter numeric(8,2), -- calculated
  station text,
  receipt_ref text, -- cupom fiscal
  financial_title_id uuid references financial_titles(id),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 2: PCP & INDÚSTRIA (MRP)
-- ============================================================================

-- Bill of Materials
create table if not exists bill_of_materials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  name text not null,
  version text not null default '1.0',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bom_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  bom_id uuid not null references bill_of_materials(id) on delete cascade,
  component_product_id uuid not null references products(id) on delete cascade,
  qty_per_unit numeric(18,4) not null,
  unit_of_measure text default 'un',
  scrap_pct numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);

-- Production Orders
create table if not exists production_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  bom_id uuid not null references bill_of_materials(id),
  product_id uuid not null references products(id),
  warehouse_id uuid not null references warehouses(id),
  qty_planned numeric(18,4) not null,
  qty_produced numeric(18,4) not null default 0,
  status text not null default 'planned' check (status in ('planned', 'released', 'in_progress', 'completed', 'cancelled')),
  start_date date,
  end_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists production_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete cascade,
  component_product_id uuid not null references products(id),
  qty_required numeric(18,4) not null,
  qty_consumed numeric(18,4) not null default 0,
  created_at timestamptz not null default now()
);

-- Production Costs
create table if not exists production_costs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete cascade,
  cost_type text not null check (cost_type in ('material', 'labor', 'fixed', 'variable', 'other')),
  description text,
  amount numeric(18,2) not null,
  created_at timestamptz not null default now()
);

-- Machine Stops
create table if not exists machine_stops (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid references production_orders(id) on delete set null,
  machine_name text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_minutes int,
  reason text,
  created_at timestamptz not null default now()
);

-- Production Waste
create table if not exists production_waste (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  production_order_id uuid not null references production_orders(id) on delete cascade,
  component_product_id uuid not null references products(id),
  qty_wasted numeric(18,4) not null,
  reason text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 9: PATRIMÔNIO (ATIVO IMOBILIZADO)
-- ============================================================================

create table if not exists fixed_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  category text not null, -- 'machine', 'computer', 'furniture', 'vehicle', 'real_estate', 'other'
  asset_number text,
  acquisition_value numeric(18,2) not null,
  acquisition_date date not null,
  useful_life_months int not null default 60,
  depreciation_method text not null default 'linear' check (depreciation_method in ('linear', 'accelerated')),
  residual_value numeric(18,2) not null default 0,
  current_value numeric(18,2),
  responsible_user_id uuid references auth.users(id),
  location_description text,
  status text not null default 'active' check (status in ('active', 'maintenance', 'disposed', 'transferred')),
  disposed_at date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, asset_number)
);

create table if not exists asset_depreciations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  asset_id uuid not null references fixed_assets(id) on delete cascade,
  reference_month date not null, -- first day of month
  depreciation_value numeric(18,2) not null,
  accumulated_depreciation numeric(18,2) not null,
  book_value numeric(18,2) not null,
  created_at timestamptz not null default now(),
  unique (organization_id, asset_id, reference_month)
);

create table if not exists asset_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  asset_id uuid not null references fixed_assets(id) on delete cascade,
  from_user_id uuid references auth.users(id),
  to_user_id uuid references auth.users(id),
  transfer_date date not null default current_date,
  reason text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 6: INTELIGÊNCIA (IA INTEGRADA)
-- ============================================================================

create table if not exists churn_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  score numeric(5,2) not null, -- 0-100
  risk_level text not null check (risk_level in ('low', 'medium', 'high')),
  days_since_last_purchase int,
  purchase_frequency_days numeric(10,2),
  avg_ticket numeric(18,2),
  calculated_at timestamptz not null default now()
);

create table if not exists anomaly_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  alert_type text not null check (alert_type in ('financial_amount', 'financial_frequency', 'unusual_time', 'other')),
  entity_type text not null,
  record_id uuid not null,
  description text,
  severity numeric(5,2) not null default 50, -- z-score based
  reviewed boolean not null default false,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 10: AUTOMAÇÃO DE PROCESSOS (BPMN)
-- ============================================================================

create table if not exists automation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  trigger_event text not null, -- 'sale_created', 'stock_low', 'title_overdue', 'order_above_value', etc
  conditions jsonb not null default '{}',
  actions jsonb not null default '[]', -- [{type: 'email', to: '...', template: '...'}, {type: 'webhook', url: '...'}]
  active boolean not null default true,
  last_triggered_at timestamptz,
  execution_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists automation_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  rule_id uuid not null references automation_rules(id) on delete cascade,
  trigger_data jsonb,
  result text not null check (result in ('success', 'partial', 'failed')),
  error_message text,
  executed_at timestamptz not null default now()
);

-- Signature Requests
create table if not exists signature_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_type text not null, -- 'contract', 'service_order', 'sales_order'
  document_id uuid not null,
  provider text not null default 'zapsign' check (provider in ('zapsign', 'docusign', 'adobe_sign')),
  external_id text,
  signer_name text,
  signer_email text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'viewed', 'signed', 'refused', 'expired')),
  signed_at timestamptz,
  sent_at timestamptz,
  document_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 8: COMÉRCIO EXTERIOR (IMPORTAÇÃO)
-- ============================================================================

create table if not exists import_processes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_id uuid references suppliers(id),
  reference_number text,
  incoterm text not null default 'FOB' check (incoterm in ('FOB', 'CIF', 'EXW', 'FCA', 'CFR', 'CPT', 'DDP', 'DAP')),
  currency text not null default 'USD',
  exchange_rate numeric(12,6),
  total_fob numeric(18,2) not null default 0,
  total_nationalized numeric(18,2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'shipped', 'in_transit', 'customs', 'cleared', 'delivered', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists import_costs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  process_id uuid not null references import_processes(id) on delete cascade,
  cost_type text not null check (cost_type in ('freight_intl', 'insurance', 'import_tax', 'ipi', 'icms', 'pis_cofins', 'port_fees', 'customs_broker', 'storage', 'inland_freight', 'other')),
  description text,
  amount_original numeric(18,2) not null default 0,
  amount_brl numeric(18,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists import_containers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  process_id uuid not null references import_processes(id) on delete cascade,
  container_number text,
  container_type text default '40ft' check (container_type in ('20ft', '40ft', '40hc', 'reefer', 'other')),
  bill_of_lading text,
  shipping_date date,
  eta_port date,
  actual_arrival date,
  status text not null default 'pending' check (status in ('pending', 'shipped', 'in_transit', 'at_port', 'cleared', 'delivered')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists import_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  process_id uuid not null references import_processes(id) on delete cascade,
  product_id uuid not null references products(id),
  quantity numeric(18,4) not null,
  fob_unit_price numeric(18,4) not null,
  nationalized_unit_cost numeric(18,4), -- calculated after cost apportionment
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 11: QUALIDADE (QMS)
-- ============================================================================

-- Non-Conformity Reports
create table if not exists nonconformity_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  ncr_number serial,
  ncr_type text not null check (ncr_type in ('product', 'process', 'supplier', 'customer', 'internal')),
  title text not null,
  description text,
  root_cause text,
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  status text not null default 'open' check (status in ('open', 'analyzing', 'action_plan', 'implementing', 'verifying', 'closed')),
  responsible_user_id uuid references auth.users(id),
  action_plan jsonb, -- 5W2H structure
  product_id uuid references products(id),
  supplier_id uuid references suppliers(id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Calibration Instruments
create table if not exists calibration_instruments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  code text not null,
  instrument_type text, -- 'scale', 'thermometer', 'caliper', etc
  last_calibration date,
  next_calibration date,
  calibration_interval_days int not null default 365,
  status text not null default 'calibrated' check (status in ('calibrated', 'overdue', 'in_calibration', 'retired')),
  certificate_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

-- Controlled Documents (GED)
create table if not exists controlled_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  doc_type text not null check (doc_type in ('manual', 'norm', 'pop', 'instruction', 'form', 'policy', 'other')),
  current_version text not null default '1.0',
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'obsolete')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  content_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists document_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_id uuid not null references controlled_documents(id) on delete cascade,
  version text not null,
  changes_description text,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  content_url text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 12: TESOURARIA AVANÇADA
-- ============================================================================

create table if not exists treasury_loans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  loan_type text not null check (loan_type in ('loan', 'investment')),
  bank_name text,
  principal_amount numeric(18,2) not null,
  interest_rate numeric(8,4) not null, -- annual %
  amortization_system text not null default 'price' check (amortization_system in ('sac', 'price')),
  total_installments int not null,
  start_date date not null,
  status text not null default 'active' check (status in ('active', 'paid_off', 'defaulted', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists treasury_loan_installments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  loan_id uuid not null references treasury_loans(id) on delete cascade,
  installment_number int not null,
  amortization numeric(18,2) not null,
  interest numeric(18,2) not null,
  total_amount numeric(18,2) not null,
  outstanding_balance numeric(18,2) not null,
  due_date date not null,
  paid_at date,
  status text not null default 'open' check (status in ('open', 'paid', 'overdue')),
  created_at timestamptz not null default now()
);

create table if not exists intercompany_transfers (
  id uuid primary key default gen_random_uuid(),
  source_organization_id uuid not null references organizations(id) on delete cascade,
  target_organization_id uuid not null references organizations(id) on delete cascade,
  transfer_type text not null check (transfer_type in ('financial', 'merchandise')),
  amount numeric(18,2) not null,
  description text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'completed', 'cancelled')),
  source_title_id uuid references financial_titles(id),
  target_title_id uuid references financial_titles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 15: GESTÃO DE PROJETOS (PSA)
-- ============================================================================

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  customer_id uuid references customers(id),
  manager_user_id uuid references auth.users(id),
  status text not null default 'planning' check (status in ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  start_date date,
  expected_end_date date,
  actual_end_date date,
  budget numeric(18,2),
  spent numeric(18,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  description text,
  assigned_user_id uuid references auth.users(id),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'review', 'done', 'cancelled')),
  start_date date,
  end_date date,
  depends_on_task_id uuid references project_tasks(id),
  sort_order int not null default 0,
  estimated_hours numeric(8,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_timesheets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references project_tasks(id),
  user_id uuid not null references auth.users(id),
  work_date date not null,
  hours numeric(6,2) not null,
  hourly_cost numeric(18,2) not null default 0,
  total_cost numeric(18,2) not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists project_milestones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  planned_date date,
  completed_date date,
  billing_amount numeric(18,2),
  billed boolean not null default false,
  financial_title_id uuid references financial_titles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 14: ESG & COMPLIANCE
-- ============================================================================

create table if not exists carbon_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  entry_type text not null check (entry_type in ('fuel', 'electricity', 'waste', 'transport', 'other')),
  source_ref_table text,
  source_ref_id uuid,
  period_start date not null,
  period_end date not null,
  quantity numeric(18,4) not null,
  unit text not null, -- liters, kWh, kg, km, etc
  emission_factor numeric(12,6) not null, -- kg CO2 per unit
  co2_kg numeric(18,4) not null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists compliance_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  report_type text not null check (report_type in ('complaint', 'observation', 'suggestion', 'irregularity')),
  description text not null,
  is_anonymous boolean not null default true,
  reporter_user_id uuid references auth.users(id), -- null if anonymous
  status text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'dismissed')),
  assigned_to uuid references auth.users(id),
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- MODULE 16: GESTÃO DE FRANQUIAS E FILIAIS
-- ============================================================================

create table if not exists franchise_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_organization_id uuid not null references organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists franchise_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references franchise_groups(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  member_type text not null check (member_type in ('headquarters', 'branch', 'franchisee')),
  joined_at timestamptz not null default now(),
  active boolean not null default true,
  unique (group_id, organization_id)
);

create table if not exists franchise_royalty_rules (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references franchise_groups(id) on delete cascade,
  rule_type text not null check (rule_type in ('royalty', 'marketing_fee', 'technology_fee')),
  percentage numeric(5,2) not null,
  base text not null default 'gross_revenue' check (base in ('gross_revenue', 'net_revenue')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists franchise_catalog_overrides (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references franchise_groups(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  regional_price numeric(18,2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, organization_id, product_id)
);

-- ============================================================================
-- MODULE 13: PORTAL ACCESS (shared tokens for supplier/customer/accountant)
-- ============================================================================

create table if not exists portal_access_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  portal_type text not null check (portal_type in ('supplier', 'customer', 'accountant')),
  entity_id uuid, -- supplier_id, customer_id, or accountant user_id
  entity_name text,
  token text not null unique,
  permissions jsonb not null default '[]', -- ['view_payments', 'upload_xml', 'view_invoices']
  expires_at timestamptz not null,
  last_used_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- RLS POLICIES FOR ALL NEW TABLES
-- ============================================================================

-- Enable RLS
alter table cost_centers enable row level security;
alter table billing_rules enable row level security;
alter table billing_rule_executions enable row level security;
alter table cnab_returns enable row level security;
alter table cnab_return_entries enable row level security;
alter table record_versions enable row level security;
alter table approval_rules enable row level security;
alter table approval_requests enable row level security;
alter table stock_snapshots enable row level security;
alter table warehouse_locations enable row level security;
alter table pick_lists enable row level security;
alter table pick_list_items enable row level security;
alter table fleet_tires enable row level security;
alter table fleet_incidents enable row level security;
alter table fleet_maintenance_plans enable row level security;
alter table fleet_refueling enable row level security;
alter table bill_of_materials enable row level security;
alter table bom_items enable row level security;
alter table production_orders enable row level security;
alter table production_order_items enable row level security;
alter table production_costs enable row level security;
alter table machine_stops enable row level security;
alter table production_waste enable row level security;
alter table fixed_assets enable row level security;
alter table asset_depreciations enable row level security;
alter table asset_transfers enable row level security;
alter table churn_scores enable row level security;
alter table anomaly_alerts enable row level security;
alter table automation_rules enable row level security;
alter table automation_executions enable row level security;
alter table signature_requests enable row level security;
alter table import_processes enable row level security;
alter table import_costs enable row level security;
alter table import_containers enable row level security;
alter table import_items enable row level security;
alter table nonconformity_reports enable row level security;
alter table calibration_instruments enable row level security;
alter table controlled_documents enable row level security;
alter table document_versions enable row level security;
alter table treasury_loans enable row level security;
alter table treasury_loan_installments enable row level security;
alter table intercompany_transfers enable row level security;
alter table projects enable row level security;
alter table project_tasks enable row level security;
alter table project_timesheets enable row level security;
alter table project_milestones enable row level security;
alter table carbon_entries enable row level security;
alter table compliance_reports enable row level security;
alter table franchise_groups enable row level security;
alter table franchise_members enable row level security;
alter table franchise_royalty_rules enable row level security;
alter table franchise_catalog_overrides enable row level security;
alter table portal_access_tokens enable row level security;

-- Create standard tenant RLS policies for all new org-scoped tables
do $$
declare
  tbl text;
begin
  for tbl in
    select unnest(array[
      'cost_centers', 'billing_rules', 'billing_rule_executions',
      'cnab_returns', 'cnab_return_entries',
      'record_versions', 'approval_rules', 'approval_requests',
      'stock_snapshots', 'warehouse_locations', 'pick_lists', 'pick_list_items',
      'fleet_tires', 'fleet_incidents', 'fleet_maintenance_plans', 'fleet_refueling',
      'bill_of_materials', 'bom_items', 'production_orders', 'production_order_items',
      'production_costs', 'machine_stops', 'production_waste',
      'fixed_assets', 'asset_depreciations', 'asset_transfers',
      'churn_scores', 'anomaly_alerts',
      'automation_rules', 'automation_executions', 'signature_requests',
      'import_processes', 'import_costs', 'import_containers', 'import_items',
      'nonconformity_reports', 'calibration_instruments', 'controlled_documents', 'document_versions',
      'treasury_loans', 'treasury_loan_installments',
      'projects', 'project_tasks', 'project_timesheets', 'project_milestones',
      'carbon_entries', 'compliance_reports', 'portal_access_tokens'
    ])
  loop
    execute format(
      'create policy if not exists mega_select on %I for select using (has_org_access(organization_id))',
      tbl
    );
    execute format(
      'create policy if not exists mega_insert on %I for insert with check (has_org_access(organization_id))',
      tbl
    );
    execute format(
      'create policy if not exists mega_update on %I for update using (has_org_access(organization_id)) with check (has_org_access(organization_id))',
      tbl
    );
    execute format(
      'create policy if not exists mega_delete on %I for delete using (has_org_access(organization_id))',
      tbl
    );
  end loop;
end
$$;

-- Franchise tables use parent_organization_id or source_organization_id
create policy mega_select on franchise_groups for select using (has_org_access(parent_organization_id));
create policy mega_insert on franchise_groups for insert with check (has_org_access(parent_organization_id));
create policy mega_update on franchise_groups for update using (has_org_access(parent_organization_id)) with check (has_org_access(parent_organization_id));
create policy mega_delete on franchise_groups for delete using (has_org_access(parent_organization_id));

create policy mega_select on franchise_members for select using (exists (
  select 1 from franchise_groups fg where fg.id = group_id and has_org_access(fg.parent_organization_id)
));
create policy mega_insert on franchise_members for insert with check (exists (
  select 1 from franchise_groups fg where fg.id = group_id and has_org_access(fg.parent_organization_id)
));

create policy mega_select on franchise_royalty_rules for select using (exists (
  select 1 from franchise_groups fg where fg.id = group_id and has_org_access(fg.parent_organization_id)
));
create policy mega_insert on franchise_royalty_rules for insert with check (exists (
  select 1 from franchise_groups fg where fg.id = group_id and has_org_access(fg.parent_organization_id)
));

create policy mega_select on franchise_catalog_overrides for select using (exists (
  select 1 from franchise_groups fg where fg.id = group_id and has_org_access(fg.parent_organization_id)
));
create policy mega_insert on franchise_catalog_overrides for insert with check (exists (
  select 1 from franchise_groups fg where fg.id = group_id and has_org_access(fg.parent_organization_id)
));

-- Intercompany transfers: both sides can see
create policy mega_select_source on intercompany_transfers for select using (has_org_access(source_organization_id));
create policy mega_select_target on intercompany_transfers for select using (has_org_access(target_organization_id));
create policy mega_insert on intercompany_transfers for insert with check (has_org_access(source_organization_id));
create policy mega_update on intercompany_transfers for update using (has_org_access(source_organization_id));

-- ============================================================================
-- TRIGGERS: updated_at for new tables
-- ============================================================================

do $$
declare
  tbl text;
begin
  for tbl in
    select unnest(array[
      'cost_centers', 'billing_rules', 'approval_rules', 'approval_requests',
      'warehouse_locations', 'pick_lists',
      'fleet_tires', 'fleet_incidents', 'fleet_maintenance_plans',
      'bill_of_materials', 'production_orders',
      'fixed_assets',
      'automation_rules', 'signature_requests',
      'import_processes', 'import_containers',
      'nonconformity_reports', 'calibration_instruments', 'controlled_documents',
      'treasury_loans', 'intercompany_transfers',
      'projects', 'project_tasks', 'project_milestones',
      'compliance_reports', 'franchise_groups', 'franchise_catalog_overrides'
    ])
  loop
    execute format(
      'create trigger %I_updated_at before update on %I for each row execute function set_updated_at()',
      tbl, tbl
    );
  end loop;
end
$$;

-- ============================================================================
-- INDEXES for performance
-- ============================================================================

create index if not exists idx_cost_centers_org on cost_centers (organization_id);
create index if not exists idx_billing_rules_org on billing_rules (organization_id, active);
create index if not exists idx_cnab_returns_org on cnab_returns (organization_id, created_at desc);
create index if not exists idx_approval_requests_pending on approval_requests (organization_id, status) where status = 'pending';
create index if not exists idx_warehouse_locations_warehouse on warehouse_locations (organization_id, warehouse_id);
create index if not exists idx_pick_lists_org on pick_lists (organization_id, status);
create index if not exists idx_fleet_tires_vehicle on fleet_tires (organization_id, vehicle_id);
create index if not exists idx_fleet_incidents_vehicle on fleet_incidents (organization_id, vehicle_id);
create index if not exists idx_fleet_maint_plans_vehicle on fleet_maintenance_plans (organization_id, vehicle_id);
create index if not exists idx_fleet_refueling_vehicle on fleet_refueling (organization_id, vehicle_id);
create index if not exists idx_bom_product on bill_of_materials (organization_id, product_id);
create index if not exists idx_prod_orders_org on production_orders (organization_id, status);
create index if not exists idx_fixed_assets_org on fixed_assets (organization_id, status);
create index if not exists idx_churn_scores_customer on churn_scores (organization_id, customer_id);
create index if not exists idx_anomaly_alerts_org on anomaly_alerts (organization_id, reviewed);
create index if not exists idx_automation_rules_org on automation_rules (organization_id, active);
create index if not exists idx_import_processes_org on import_processes (organization_id, status);
create index if not exists idx_ncr_org on nonconformity_reports (organization_id, status);
create index if not exists idx_calibration_org on calibration_instruments (organization_id, status);
create index if not exists idx_controlled_docs_org on controlled_documents (organization_id, status);
create index if not exists idx_treasury_loans_org on treasury_loans (organization_id, status);
create index if not exists idx_projects_org on projects (organization_id, status);
create index if not exists idx_project_tasks_project on project_tasks (organization_id, project_id);
create index if not exists idx_carbon_entries_org on carbon_entries (organization_id, entry_type);
create index if not exists idx_compliance_reports_org on compliance_reports (organization_id, status);
create index if not exists idx_portal_tokens_org on portal_access_tokens (organization_id, portal_type, active);
create index if not exists idx_franchise_members_group on franchise_members (group_id, organization_id);
