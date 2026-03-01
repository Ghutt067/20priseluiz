import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Pagination,
  SearchToolbar, PageHeader, KpiCard, KpiRow, Select,
  DetailPanel, DetailField, DetailGrid,
} from '../../components/ui'
import { LookupField, type LookupSearchParams } from '../inventory/LookupFields'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtCurrency, fmtDate, fmtQty } from '../../lib/formatters'
import {
  fetchVehiclesPaged, fetchTires, createTire, updateTire, deleteTire,
  fetchIncidents, createIncident, updateIncident,
  fetchMaintenancePlans, createMaintenancePlan, updateMaintenancePlan, deleteMaintenancePlan,
  fetchRefueling, createRefueling, fetchMaintenanceAlerts, fetchFleetDashboard,
  updateVehicleFleet, searchVehiclesLookup,
  type VehicleFleet, type FleetTire, type FleetIncident,
  type FleetMaintenancePlan, type FleetRefueling, type FleetAlert,
  type FleetDashboard, type VehicleLookupItem,
} from '../../services/fleet'

type Tab = 'dashboard' | 'vehicles' | 'tires' | 'refueling' | 'maintenance' | 'incidents' | 'alerts'

const PAGE_SIZE = 20

const fleetStatusLabel: Record<string, string> = {
  active: 'Ativo', maintenance: 'Em manutenção', inactive: 'Inativo', sold: 'Vendido',
}
const tireStatusLabel: Record<string, string> = {
  active: 'Ativo', worn: 'Desgastado', retreaded: 'Recapado', removed: 'Removido',
}
const incidentStatusLabel: Record<string, string> = {
  open: 'Aberto', in_progress: 'Em andamento', insurance_claim: 'Seguradora', resolved: 'Resolvido', closed: 'Encerrado',
}
const incidentTypeLabel: Record<string, string> = {
  accident: 'Acidente', fine: 'Multa', theft: 'Roubo/Furto', vandalism: 'Vandalismo', mechanical: 'Mecânico', other: 'Outro',
}
const fuelTypeLabel: Record<string, string> = {
  gasoline: 'Gasolina', ethanol: 'Etanol', diesel: 'Diesel', flex: 'Flex', gnv: 'GNV', electric: 'Elétrico',
}
const planTypeLabel: Record<string, string> = {
  km: 'Por KM', time: 'Por Tempo', both: 'KM + Tempo',
}

function label(map: Record<string, string>, key: string | null | undefined): string {
  return map[key ?? ''] ?? key ?? '—'
}

export function FrotaPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)

  const [dashboard, setDashboard] = useState<FleetDashboard | null>(null)
  const [dashLoading, setDashLoading] = useState(false)

  const [vehicles, setVehicles] = useState<VehicleFleet[]>([])
  const [vehicleTotal, setVehicleTotal] = useState(0)
  const [vehicleOffset, setVehicleOffset] = useState(0)
  const [vehicleSearch, setVehicleSearch] = useState('')
  const [vehicleStatusFilter, setVehicleStatusFilter] = useState('')
  const [vehicleLoading, setVehicleLoading] = useState(false)
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleFleet | null>(null)

  const [tires, setTires] = useState<FleetTire[]>([])
  const [tiresLoading, setTiresLoading] = useState(false)

  const [refuelingList, setRefuelingList] = useState<FleetRefueling[]>([])
  const [refuelingLoading, setRefuelingLoading] = useState(false)

  const [maintenance, setMaintenance] = useState<FleetMaintenancePlan[]>([])
  const [maintenanceLoading, setMaintenanceLoading] = useState(false)

  const [incidents, setIncidents] = useState<FleetIncident[]>([])
  const [incidentStatusFilter, setIncidentStatusFilter] = useState('')
  const [incidentsLoading, setIncidentsLoading] = useState(false)

  const [alerts, setAlerts] = useState<FleetAlert[]>([])
  const [alertsLoading, setAlertsLoading] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  useStatusToast(status)

  const canManage = can(role ?? '', 'fleet.vehicle.manage')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'vehicles' as const, label: 'Veículos', count: vehicleTotal },
    { key: 'tires' as const, label: 'Pneus' },
    { key: 'refueling' as const, label: 'Abastecimento' },
    { key: 'maintenance' as const, label: 'Manutenção' },
    { key: 'incidents' as const, label: 'Sinistros' },
    { key: 'alerts' as const, label: 'Alertas', count: alerts.length },
  ], [vehicleTotal, alerts.length])

  const loadDashboard = useCallback(async () => {
    if (!organizationId) return
    setDashLoading(true)
    try { setDashboard(await fetchFleetDashboard()) } catch { /* */ }
    setDashLoading(false)
  }, [organizationId])

  const loadVehicles = useCallback(async () => {
    if (!organizationId) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setVehicleLoading(true)
    try {
      const r = await fetchVehiclesPaged({
        query: vehicleSearch, status: vehicleStatusFilter || undefined,
        limit: PAGE_SIZE, offset: vehicleOffset, signal: ctrl.signal,
      })
      setVehicles(r.rows)
      setVehicleTotal(r.totalCount)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setStatus(e instanceof Error ? e.message : 'Erro ao carregar veículos.')
    }
    setVehicleLoading(false)
  }, [organizationId, vehicleSearch, vehicleStatusFilter, vehicleOffset])

  const loadTires = useCallback(async () => {
    if (!organizationId) return
    setTiresLoading(true)
    try { setTires(await fetchTires()) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setTiresLoading(false)
  }, [organizationId])

  const loadRefueling = useCallback(async () => {
    if (!organizationId) return
    setRefuelingLoading(true)
    try { setRefuelingList(await fetchRefueling()) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setRefuelingLoading(false)
  }, [organizationId])

  const loadMaintenance = useCallback(async () => {
    if (!organizationId) return
    setMaintenanceLoading(true)
    try { setMaintenance(await fetchMaintenancePlans()) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setMaintenanceLoading(false)
  }, [organizationId])

  const loadIncidents = useCallback(async () => {
    if (!organizationId) return
    setIncidentsLoading(true)
    try {
      const all = await fetchIncidents()
      setIncidents(incidentStatusFilter ? all.filter(i => i.status === incidentStatusFilter) : all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setIncidentsLoading(false)
  }, [organizationId, incidentStatusFilter])

  const loadAlerts = useCallback(async () => {
    if (!organizationId) return
    setAlertsLoading(true)
    try { setAlerts(await fetchMaintenanceAlerts()) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setAlertsLoading(false)
  }, [organizationId])

  useEffect(() => {
    if (tab === 'dashboard') void loadDashboard()
    if (tab === 'vehicles') void loadVehicles()
    if (tab === 'tires') void loadTires()
    if (tab === 'refueling') void loadRefueling()
    if (tab === 'maintenance') void loadMaintenance()
    if (tab === 'incidents') void loadIncidents()
    if (tab === 'alerts') void loadAlerts()
    return () => { abortRef.current?.abort() }
  }, [tab, loadDashboard, loadVehicles, loadTires, loadRefueling, loadMaintenance, loadIncidents, loadAlerts])

  const refreshTab = () => {
    if (tab === 'dashboard') void loadDashboard()
    if (tab === 'vehicles') void loadVehicles()
    if (tab === 'tires') void loadTires()
    if (tab === 'refueling') void loadRefueling()
    if (tab === 'maintenance') void loadMaintenance()
    if (tab === 'incidents') void loadIncidents()
    if (tab === 'alerts') void loadAlerts()
  }

  const handleDeleteTire = async (id: string) => {
    try { await deleteTire(id); setStatus('Pneu excluído.'); void loadTires() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handleTireStatus = async (id: string, s: string) => {
    try { await updateTire(id, { status: s }); setStatus('Status do pneu atualizado.'); void loadTires() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handleIncidentStatus = async (id: string, s: string) => {
    try { await updateIncident(id, { status: s }); setStatus('Sinistro atualizado.'); void loadIncidents() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handleTogglePlan = async (id: string, active: boolean) => {
    try { await updateMaintenancePlan(id, { active: !active }); setStatus(active ? 'Plano desativado.' : 'Plano ativado.'); void loadMaintenance() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handleDeletePlan = async (id: string) => {
    try { await deleteMaintenancePlan(id); setStatus('Plano excluído.'); void loadMaintenance() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const vehicleCols: Column<VehicleFleet>[] = useMemo(() => [
    { key: 'plate', header: 'Placa', render: (v) => <strong>{v.plate ?? '—'}</strong> },
    { key: 'brand', header: 'Marca/Modelo', render: (v) => `${v.brand ?? ''} ${v.model ?? ''}`.trim() || '—' },
    { key: 'year', header: 'Ano', width: '70px', render: (v) => v.year ?? '—' },
    { key: 'km', header: 'KM Atual', align: 'right', render: (v) => fmtQty(v.kmCurrent, 0) },
    { key: 'status', header: 'Status', render: (v) => <StatusBadge status={v.fleetStatus} label={label(fleetStatusLabel, v.fleetStatus)} /> },
    { key: 'fuel', header: 'Combustível', render: (v) => label(fuelTypeLabel, v.fuelType) },
    { key: 'ipva', header: 'Venc. IPVA', render: (v) => fmtDate(v.ipvaExpiry) },
    { key: 'insurance', header: 'Venc. Seguro', render: (v) => fmtDate(v.insuranceExpiry) },
  ], [])

  const tireCols: Column<FleetTire>[] = useMemo(() => [
    { key: 'vehicle', header: 'Veículo', render: (t) => t.vehiclePlate },
    { key: 'position', header: 'Posição', render: (t) => t.position },
    { key: 'fire', header: 'Nº Fogo', render: (t) => t.fire_number ?? '—' },
    { key: 'tread', header: 'Sulcagem (mm)', align: 'right', render: (t) => t.tread_depth_mm != null ? fmtQty(t.tread_depth_mm, 1) : '—' },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} label={label(tireStatusLabel, t.status)} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (t: FleetTire) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
          {t.status === 'active' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleTireStatus(t.id, 'worn')}>Desgastado</button>}
          {t.status !== 'removed' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleTireStatus(t.id, 'removed')}>Remover</button>}
          <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleDeleteTire(t.id)}>Excluir</button>
        </div>
      ),
    }] : []),
  ], [canManage])

  const refuelingCols: Column<FleetRefueling>[] = useMemo(() => [
    { key: 'vehicle', header: 'Veículo', render: (r) => r.vehiclePlate },
    { key: 'date', header: 'Data', render: (r) => fmtDate(r.refueling_date) },
    { key: 'km', header: 'KM', align: 'right', render: (r) => fmtQty(r.km_current, 0) },
    { key: 'liters', header: 'Litros', align: 'right', render: (r) => fmtQty(r.liters, 2) },
    { key: 'cost', header: 'Valor', align: 'right', render: (r) => fmtCurrency(r.total_cost) },
    { key: 'kml', header: 'Km/L', align: 'right', render: (r) => r.km_per_liter ? fmtQty(r.km_per_liter, 2) : '—' },
    { key: 'fuel', header: 'Combustível', render: (r) => label(fuelTypeLabel, r.fuel_type) },
    { key: 'station', header: 'Posto', render: (r) => r.station ?? '—' },
  ], [])

  const maintenanceCols: Column<FleetMaintenancePlan>[] = useMemo(() => [
    { key: 'vehicle', header: 'Veículo', render: (m) => m.vehiclePlate },
    { key: 'name', header: 'Plano', render: (m) => <strong>{m.name}</strong> },
    { key: 'type', header: 'Tipo', render: (m) => label(planTypeLabel, m.plan_type) },
    { key: 'nextKm', header: 'Próx. KM', align: 'right', render: (m) => m.next_km != null ? fmtQty(m.next_km, 0) : '—' },
    { key: 'nextDate', header: 'Próx. Data', render: (m) => fmtDate(m.next_date) },
    { key: 'active', header: 'Ativo', render: (m) => m.active ? 'Sim' : 'Não' },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (m: FleetMaintenancePlan) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleTogglePlan(m.id, m.active)}>{m.active ? 'Desativar' : 'Ativar'}</button>
          <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleDeletePlan(m.id)}>Excluir</button>
        </div>
      ),
    }] : []),
  ], [canManage])

  const incidentCols: Column<FleetIncident>[] = useMemo(() => [
    { key: 'vehicle', header: 'Veículo', render: (i) => i.vehiclePlate },
    { key: 'type', header: 'Tipo', render: (i) => label(incidentTypeLabel, i.incident_type) },
    { key: 'date', header: 'Data', render: (i) => fmtDate(i.incident_date) },
    { key: 'cost', header: 'Custo', align: 'right', render: (i) => fmtCurrency(i.cost) },
    { key: 'desc', header: 'Descrição', render: (i) => i.description ?? '—' },
    { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.status} label={label(incidentStatusLabel, i.status)} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (i: FleetIncident) => (
        <div style={{ display: 'flex', gap: 4 }}>
          {i.status === 'open' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleIncidentStatus(i.id, 'in_progress')}>Em andamento</button>}
          {i.status === 'in_progress' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleIncidentStatus(i.id, 'resolved')}>Resolvido</button>}
          {i.status === 'resolved' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleIncidentStatus(i.id, 'closed')}>Encerrar</button>}
        </div>
      ),
    }] : []),
  ], [canManage])

  const alertCols: Column<FleetAlert>[] = useMemo(() => [
    { key: 'vehicle', header: 'Veículo', render: (a) => a.plate },
    { key: 'plan', header: 'Plano', render: (a) => <strong>{a.name}</strong> },
    { key: 'type', header: 'Tipo', render: (a) => label(planTypeLabel, a.planType) },
    { key: 'level', header: 'Alerta', render: (a) => <StatusBadge status={a.alert_level} /> },
    { key: 'nextKm', header: 'Próx. KM', align: 'right', render: (a) => a.nextKm != null ? fmtQty(a.nextKm, 0) : '—' },
    { key: 'nextDate', header: 'Próx. Data', render: (a) => fmtDate(a.nextDate) },
    { key: 'kmCurrent', header: 'KM Atual', align: 'right', render: (a) => fmtQty(a.kmCurrent, 0) },
  ], [])

  const vehicleStatusOptions = [
    { value: '', label: 'Todos os status' },
    { value: 'active', label: 'Ativo' },
    { value: 'maintenance', label: 'Em manutenção' },
    { value: 'inactive', label: 'Inativo' },
  ]

  const incidentStatusOptions = [
    { value: '', label: 'Todos os status' },
    { value: 'open', label: 'Aberto' },
    { value: 'in_progress', label: 'Em andamento' },
    { value: 'resolved', label: 'Resolvido' },
    { value: 'closed', label: 'Encerrado' },
  ]

  return (
    <div className="page">
      <PageHeader

        actions={<button type="button" onClick={refreshTab}>Atualizar</button>}
      />

      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false); setSelectedVehicle(null) }} />

      {/* ── DASHBOARD ── */}
      <TabPanel active={tab === 'dashboard'}>
        
        {dashboard && (
          <>
            <KpiRow>
              <KpiCard label="Total Veículos" value={dashboard.totalVehicles} />
              <KpiCard label="Ativos" value={dashboard.activeVehicles} tone="success" />
              <KpiCard label="Em Manutenção" value={dashboard.inMaintenance} tone="warning" />
              <KpiCard label="Alertas Vencidos" value={dashboard.overdueAlerts} tone={dashboard.overdueAlerts > 0 ? 'danger' : 'default'} />
              <KpiCard label="Combustível (mês)" value={fmtCurrency(dashboard.monthlyFuelCost)} />
              <KpiCard label="Km/L Médio" value={dashboard.avgKmPerLiter > 0 ? fmtQty(dashboard.avgKmPerLiter, 2) : '—'} />
            </KpiRow>
            {dashboard.overdueAlerts > 0 && (
              <div className="card" style={{ borderLeft: '3px solid #c44' }}>
                <strong>{dashboard.overdueAlerts} alerta(s) de manutenção vencido(s)</strong>
              </div>
            )}
          </>
        )}
      </TabPanel>

      {/* ── VEÍCULOS ── */}
      <TabPanel active={tab === 'vehicles'}>
        <SearchToolbar
          query={vehicleSearch}
          onQueryChange={(v) => { setVehicleSearch(v); setVehicleOffset(0) }}
          placeholder="Buscar placa, marca, modelo..."
          count={vehicleTotal}
          actions={
            <Select
              value={vehicleStatusFilter}
              options={vehicleStatusOptions}
              onChange={(v) => { setVehicleStatusFilter(v); setVehicleOffset(0) }}
            />
          }
        />
        <DataTable
          columns={vehicleCols}
          rows={vehicles}
          rowKey={(v) => v.id}
          loading={vehicleLoading}
          onRowClick={(v) => setSelectedVehicle(selectedVehicle?.id === v.id ? null : v)}
        />
        <Pagination total={vehicleTotal} offset={vehicleOffset} limit={PAGE_SIZE} loading={vehicleLoading} onPageChange={setVehicleOffset} />

        {selectedVehicle && (
          <DetailPanel
            open
            onClose={() => setSelectedVehicle(null)}
            title={`${selectedVehicle.plate ?? '—'} — ${selectedVehicle.brand ?? ''} ${selectedVehicle.model ?? ''}`}
            subtitle={`VIN: ${selectedVehicle.vin ?? '—'} • Ano: ${selectedVehicle.year ?? '—'} • Cor: ${selectedVehicle.color ?? '—'}`}
          >
            <DetailGrid columns={4}>
              <DetailField label="Status" value={label(fleetStatusLabel, selectedVehicle.fleetStatus)} />
              <DetailField label="KM Atual" value={fmtQty(selectedVehicle.kmCurrent, 0)} />
              <DetailField label="Combustível" value={label(fuelTypeLabel, selectedVehicle.fuelType)} />
              <DetailField label="Tanque (L)" value={selectedVehicle.tankLiters ? fmtQty(selectedVehicle.tankLiters, 0) : '—'} />
              <DetailField label="Venc. IPVA" value={fmtDate(selectedVehicle.ipvaExpiry)} />
              <DetailField label="Venc. Seguro" value={fmtDate(selectedVehicle.insuranceExpiry)} />
              <DetailField label="Cliente" value={selectedVehicle.customerName ?? '—'} />
              <DetailField label="Cadastro" value={fmtDate(selectedVehicle.createdAt)} />
            </DetailGrid>
            {canManage && (
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                {selectedVehicle.fleetStatus === 'active' && (
                  <button type="button" onClick={async () => { await updateVehicleFleet(selectedVehicle.id, { fleetStatus: 'maintenance' }); setStatus('Veículo enviado para manutenção.'); void loadVehicles() }}>
                    Enviar p/ Manutenção
                  </button>
                )}
                {selectedVehicle.fleetStatus === 'maintenance' && (
                  <button type="button" onClick={async () => { await updateVehicleFleet(selectedVehicle.id, { fleetStatus: 'active' }); setStatus('Veículo ativado.'); void loadVehicles() }}>
                    Ativar Veículo
                  </button>
                )}
              </div>
            )}
          </DetailPanel>
        )}
      </TabPanel>

      {/* ── PNEUS ── */}
      <TabPanel active={tab === 'tires'}>
        <SearchToolbar
          query=""
          onQueryChange={() => {}}
          placeholder="Buscar pneu..."
          count={tires.length}
          actions={canManage ? <button type="button" onClick={() => setShowForm(true)}>+ Novo Pneu</button> : undefined}
        />
        {showForm && <TireForm onSaved={() => { setShowForm(false); setStatus('Pneu registrado.'); void loadTires() }} />}
        <DataTable columns={tireCols} rows={tires} rowKey={(t) => t.id} loading={tiresLoading} />
      </TabPanel>

      {/* ── ABASTECIMENTO ── */}
      <TabPanel active={tab === 'refueling'}>
        <SearchToolbar
          query=""
          onQueryChange={() => {}}
          placeholder="Buscar abastecimento..."
          count={refuelingList.length}
          actions={canManage ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Abastecimento'}</button> : undefined}
        />
        {showForm && <RefuelingForm onSaved={() => { setShowForm(false); setStatus('Abastecimento registrado.'); void loadRefueling() }} />}
        <DataTable columns={refuelingCols} rows={refuelingList} rowKey={(r) => r.id} loading={refuelingLoading} />
      </TabPanel>

      {/* ── MANUTENÇÃO ── */}
      <TabPanel active={tab === 'maintenance'}>
        <SearchToolbar
          query=""
          onQueryChange={() => {}}
          placeholder="Buscar plano..."
          count={maintenance.length}
          actions={canManage ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Plano'}</button> : undefined}
        />
        {showForm && <MaintenancePlanForm onSaved={() => { setShowForm(false); setStatus('Plano criado.'); void loadMaintenance() }} />}
        <DataTable columns={maintenanceCols} rows={maintenance} rowKey={(m) => m.id} loading={maintenanceLoading} />
      </TabPanel>

      {/* ── SINISTROS ── */}
      <TabPanel active={tab === 'incidents'}>
        <SearchToolbar
          query=""
          onQueryChange={() => {}}
          placeholder="Buscar sinistro..."
          count={incidents.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={incidentStatusFilter} options={incidentStatusOptions} onChange={setIncidentStatusFilter} />
              {canManage && <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Sinistro'}</button>}
            </div>
          }
        />
        {showForm && <IncidentForm onSaved={() => { setShowForm(false); setStatus('Sinistro registrado.'); void loadIncidents() }} />}
        <DataTable columns={incidentCols} rows={incidents} rowKey={(i) => i.id} loading={incidentsLoading} />
      </TabPanel>

      {/* ── ALERTAS ── */}
      <TabPanel active={tab === 'alerts'}>
        <DataTable columns={alertCols} rows={alerts} rowKey={(a) => a.id} loading={alertsLoading} emptyMessage="Nenhum alerta pendente." />
      </TabPanel>
    </div>
  )
}

/* ── Sub-forms with LookupField ── */

function VehicleLookup({ value, selectedLabel, onSelect, onClear }: {
  value: string; selectedLabel: string
  onSelect: (item: VehicleLookupItem) => void; onClear: () => void
}) {
  const search = useCallback(async (params: LookupSearchParams) => {
    return searchVehiclesLookup({ query: params.query, offset: params.offset, limit: params.limit, signal: params.signal })
  }, [])

  return (
    <label className="purchase-order-lookup">
      Veículo *
      <LookupField<VehicleLookupItem>
        value={value}
        selectedLabel={selectedLabel}
        placeholder="Buscar por placa, marca..."
        searchOptions={search}
        onSelect={onSelect}
        onClear={onClear}
        renderMeta={(item) => `KM ${fmtQty(item.kmCurrent, 0)}`}
      />
    </label>
  )
}

function TireForm({ onSaved }: { onSaved: () => void }) {
  const [vehicleId, setVehicleId] = useState('')
  const [vehicleLabel, setVehicleLabel] = useState('')
  const [position, setPosition] = useState('')
  const [fireNumber, setFireNumber] = useState('')
  const [treadDepth, setTreadDepth] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!vehicleId || !position) return
    setSubmitting(true); setError('')
    try {
      await createTire({ vehicleId, position, fireNumber: fireNumber || undefined, treadDepthMm: treadDepth ? Number(treadDepth) : undefined })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <VehicleLookup value={vehicleId} selectedLabel={vehicleLabel} onSelect={(v) => { setVehicleId(v.id); setVehicleLabel(v.name) }} onClear={() => { setVehicleId(''); setVehicleLabel('') }} />
        <label>Posição * <input value={position} onChange={e => setPosition(e.target.value)} placeholder="Ex: DE, DD, TE, TD" /></label>
        <label>Nº Fogo <input value={fireNumber} onChange={e => setFireNumber(e.target.value)} /></label>
        <label>Sulcagem (mm) <input type="number" step="0.1" value={treadDepth} onChange={e => setTreadDepth(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!vehicleId || !position || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Registrar Pneu'}
        </button>
      </div>
    </div>
  )
}

function RefuelingForm({ onSaved }: { onSaved: () => void }) {
  const [vehicleId, setVehicleId] = useState('')
  const [vehicleLabel, setVehicleLabel] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [km, setKm] = useState('')
  const [liters, setLiters] = useState('')
  const [totalCost, setTotalCost] = useState('')
  const [fuelType, setFuelType] = useState('')
  const [station, setStation] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!vehicleId || !km || !liters || !totalCost) return
    setSubmitting(true); setError('')
    try {
      await createRefueling({
        vehicleId, refuelingDate: date, kmCurrent: Number(km),
        liters: Number(liters), totalCost: Number(totalCost),
        fuelType: fuelType || undefined, station: station || undefined,
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <VehicleLookup value={vehicleId} selectedLabel={vehicleLabel} onSelect={(v) => { setVehicleId(v.id); setVehicleLabel(v.name) }} onClear={() => { setVehicleId(''); setVehicleLabel('') }} />
        <label>Data * <input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label>KM Atual * <input type="number" value={km} onChange={e => setKm(e.target.value)} /></label>
        <label>Litros * <input type="number" step="0.01" value={liters} onChange={e => setLiters(e.target.value)} /></label>
        <label>Valor Total (R$) * <input type="number" step="0.01" value={totalCost} onChange={e => setTotalCost(e.target.value)} /></label>
        <label>Combustível
          <select value={fuelType} onChange={e => setFuelType(e.target.value)}>
            <option value="">Selecione</option>
            <option value="gasoline">Gasolina</option><option value="ethanol">Etanol</option>
            <option value="diesel">Diesel</option><option value="flex">Flex</option>
          </select>
        </label>
        <label>Posto <input value={station} onChange={e => setStation(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!vehicleId || !km || !liters || !totalCost || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Registrar Abastecimento'}
        </button>
      </div>
    </div>
  )
}

function MaintenancePlanForm({ onSaved }: { onSaved: () => void }) {
  const [vehicleId, setVehicleId] = useState('')
  const [vehicleLabel, setVehicleLabel] = useState('')
  const [name, setName] = useState('')
  const [planType, setPlanType] = useState('km')
  const [intervalKm, setIntervalKm] = useState('')
  const [intervalDays, setIntervalDays] = useState('')
  const [lastKm, setLastKm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!vehicleId || !name) return
    setSubmitting(true); setError('')
    try {
      await createMaintenancePlan({
        vehicleId, name, planType,
        intervalKm: intervalKm ? Number(intervalKm) : undefined,
        intervalDays: intervalDays ? Number(intervalDays) : undefined,
        lastKm: lastKm ? Number(lastKm) : undefined,
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <VehicleLookup value={vehicleId} selectedLabel={vehicleLabel} onSelect={(v) => { setVehicleId(v.id); setVehicleLabel(v.name) }} onClear={() => { setVehicleId(''); setVehicleLabel('') }} />
        <label>Nome do Plano * <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Troca de óleo" /></label>
        <label>Tipo
          <select value={planType} onChange={e => setPlanType(e.target.value)}>
            <option value="km">Por KM</option><option value="time">Por Tempo</option><option value="both">Ambos</option>
          </select>
        </label>
        {(planType === 'km' || planType === 'both') && <label>Intervalo (KM) <input type="number" value={intervalKm} onChange={e => setIntervalKm(e.target.value)} /></label>}
        {(planType === 'time' || planType === 'both') && <label>Intervalo (dias) <input type="number" value={intervalDays} onChange={e => setIntervalDays(e.target.value)} /></label>}
        <label>Último KM <input type="number" value={lastKm} onChange={e => setLastKm(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!vehicleId || !name || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Criar Plano'}
        </button>
      </div>
    </div>
  )
}

function IncidentForm({ onSaved }: { onSaved: () => void }) {
  const [vehicleId, setVehicleId] = useState('')
  const [vehicleLabel, setVehicleLabel] = useState('')
  const [incidentType, setIncidentType] = useState('accident')
  const [incidentDate, setIncidentDate] = useState(new Date().toISOString().slice(0, 10))
  const [description, setDescription] = useState('')
  const [cost, setCost] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!vehicleId) return
    setSubmitting(true); setError('')
    try {
      await createIncident({
        vehicleId, incidentType, incidentDate,
        description: description || undefined, cost: cost ? Number(cost) : undefined,
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <VehicleLookup value={vehicleId} selectedLabel={vehicleLabel} onSelect={(v) => { setVehicleId(v.id); setVehicleLabel(v.name) }} onClear={() => { setVehicleId(''); setVehicleLabel('') }} />
        <label>Tipo
          <select value={incidentType} onChange={e => setIncidentType(e.target.value)}>
            <option value="accident">Acidente</option><option value="fine">Multa</option>
            <option value="theft">Roubo/Furto</option><option value="vandalism">Vandalismo</option>
            <option value="mechanical">Mecânico</option><option value="other">Outro</option>
          </select>
        </label>
        <label>Data * <input type="date" value={incidentDate} onChange={e => setIncidentDate(e.target.value)} /></label>
        <label>Descrição <input value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label>Custo (R$) <input type="number" step="0.01" value={cost} onChange={e => setCost(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!vehicleId || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Registrar Sinistro'}
        </button>
      </div>
    </div>
  )
}
