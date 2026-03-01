-- Fiscal events table (CC-e, Cancelamento, Manifestação, etc.)
create table if not exists fiscal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  document_id uuid not null references fiscal_documents(id) on delete cascade,
  event_type text not null check (event_type in ('cce', 'cancelamento', 'manifestacao', 'inutilizacao')),
  protocol text,
  xml text,
  created_at timestamptz not null default now()
);

create index if not exists idx_fiscal_events_doc on fiscal_events(document_id, organization_id);
create index if not exists idx_fiscal_events_type on fiscal_events(organization_id, event_type);

-- RLS
alter table fiscal_events enable row level security;

create policy "org_fiscal_events_select" on fiscal_events for select
  using (organization_id = current_setting('app.organization_id')::uuid);

create policy "org_fiscal_events_insert" on fiscal_events for insert
  with check (organization_id = current_setting('app.organization_id')::uuid);
