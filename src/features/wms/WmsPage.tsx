import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Pagination,
  SearchToolbar, PageHeader, KpiCard, KpiRow, Select,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtDate, fmtQty } from '../../lib/formatters'
import {
  fetchLocationsPaged, createLocation, updateLocation, deleteLocation,
  fetchPickLists, packPickList, fetchWmsDashboard,
  calculateCubage, type WarehouseLocation, type PickList, type CubageResult, type WmsDashboard,
} from '../../services/wms'

type Tab = 'dashboard' | 'locations' | 'picklists' | 'cubage'

const PAGE_SIZE = 20

const pickStatusLabel: Record<string, string> = {
  pending: 'Pendente', picking: 'Separando', picked: 'Separado',
  packing: 'Embalando', packed: 'Embalado', shipped: 'Enviado',
}

function lbl(map: Record<string, string>, key: string): string {
  return map[key] ?? key
}

export function WmsPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)

  const [dash, setDash] = useState<WmsDashboard | null>(null)
  const [dashLoading, setDashLoading] = useState(false)

  const [locations, setLocations] = useState<WarehouseLocation[]>([])
  const [locTotal, setLocTotal] = useState(0)
  const [locOffset, setLocOffset] = useState(0)
  const [locSearch, setLocSearch] = useState('')
  const [locLoading, setLocLoading] = useState(false)

  const [pickLists, setPickLists] = useState<PickList[]>([])
  const [pickStatusFilter, setPickStatusFilter] = useState('')
  const [pickLoading, setPickLoading] = useState(false)

  const [cubageResult, setCubageResult] = useState<CubageResult | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  useStatusToast(status)
  const canManage = can(role ?? '', 'wms.location.manage')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'locations' as const, label: 'Endereçamento', count: locTotal },
    { key: 'picklists' as const, label: 'Picking / Packing' },
    { key: 'cubage' as const, label: 'Cubagem' },
  ], [locTotal])

  const loadDash = useCallback(async () => {
    if (!organizationId) return
    setDashLoading(true)
    try { setDash(await fetchWmsDashboard()) } catch { /* */ }
    setDashLoading(false)
  }, [organizationId])

  const loadLocs = useCallback(async () => {
    if (!organizationId) return
    abortRef.current?.abort()
    const ctrl = new AbortController(); abortRef.current = ctrl
    setLocLoading(true)
    try {
      const r = await fetchLocationsPaged({ query: locSearch, offset: locOffset, limit: PAGE_SIZE, signal: ctrl.signal })
      setLocations(r.rows); setLocTotal(r.totalCount)
    } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setStatus(e instanceof Error ? e.message : 'Erro.') }
    setLocLoading(false)
  }, [organizationId, locSearch, locOffset])

  const loadPicks = useCallback(async () => {
    if (!organizationId) return
    setPickLoading(true)
    try {
      const all = await fetchPickLists(pickStatusFilter || undefined)
      setPickLists(all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setPickLoading(false)
  }, [organizationId, pickStatusFilter])

  useEffect(() => {
    if (tab === 'dashboard') void loadDash()
    if (tab === 'locations') void loadLocs()
    if (tab === 'picklists') void loadPicks()
    return () => { abortRef.current?.abort() }
  }, [tab, loadDash, loadLocs, loadPicks])

  const handleToggleLocation = async (id: string, active: boolean) => {
    try { await updateLocation(id, { active: !active }); setStatus(active ? 'Endereço desativado.' : 'Endereço ativado.'); void loadLocs() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handleDeleteLocation = async (id: string) => {
    try { await deleteLocation(id); setStatus('Endereço excluído.'); void loadLocs() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handlePack = async (plId: string) => {
    try { await packPickList(plId); setStatus('Pick list embalada.'); void loadPicks() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const locCols: Column<WarehouseLocation>[] = useMemo(() => [
    { key: 'code', header: 'Código', render: (l) => <strong>{l.code}</strong> },
    { key: 'warehouse', header: 'Depósito', render: (l) => l.warehouseName },
    { key: 'aisle', header: 'Rua', render: (l) => l.aisle },
    { key: 'shelf', header: 'Prateleira', render: (l) => l.shelf },
    { key: 'level', header: 'Nível', render: (l) => l.level },
    { key: 'active', header: 'Ativo', render: (l) => l.active ? 'Sim' : 'Não' },
    { key: 'created', header: 'Criação', render: (l) => fmtDate(l.createdAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (l: WarehouseLocation) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleToggleLocation(l.id, l.active)}>{l.active ? 'Desativar' : 'Ativar'}</button>
          <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleDeleteLocation(l.id)}>Excluir</button>
        </div>
      ),
    }] : []),
  ], [canManage])

  const pickCols: Column<PickList>[] = useMemo(() => [
    { key: 'id', header: 'ID', render: (p) => p.id.slice(0, 8) },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} label={lbl(pickStatusLabel, p.status)} /> },
    { key: 'items', header: 'Itens', align: 'right', render: (p) => p.itemCount },
    { key: 'picked', header: 'Separado em', render: (p) => fmtDate(p.pickedAt) },
    { key: 'packed', header: 'Embalado em', render: (p) => fmtDate(p.packedAt) },
    { key: 'created', header: 'Criação', render: (p) => fmtDate(p.createdAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (p: PickList) => (
        (p.status === 'picked' || p.status === 'packing')
          ? <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={() => void handlePack(p.id)}>Embalar</button>
          : null
      ),
    }] : []),
  ], [canManage])

  const pickStatusOptions = [
    { value: '', label: 'Todos os status' },
    { value: 'pending', label: 'Pendente' },
    { value: 'picking', label: 'Separando' },
    { value: 'picked', label: 'Separado' },
    { value: 'packing', label: 'Embalando' },
    { value: 'packed', label: 'Embalado' },
    { value: 'shipped', label: 'Enviado' },
  ]

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false) }} />

      <TabPanel active={tab === 'dashboard'}>
        
        {dash && (
          <KpiRow>
            <KpiCard label="Total Endereços" value={dash.totalLocations} />
            <KpiCard label="Endereços Ativos" value={dash.activeLocations} tone="success" />
            <KpiCard label="Pick Lists Pendentes" value={dash.pendingPickLists} tone={dash.pendingPickLists > 0 ? 'warning' : 'default'} />
          </KpiRow>
        )}
      </TabPanel>

      <TabPanel active={tab === 'locations'}>
        <SearchToolbar
          query={locSearch}
          onQueryChange={(v) => { setLocSearch(v); setLocOffset(0) }}
          placeholder="Buscar código, depósito, rua..."
          count={locTotal}
          actions={canManage ? <button type="button" onClick={() => setShowForm(true)}>+ Novo Endereço</button> : undefined}
        />
        {showForm && <LocationForm onSaved={() => { setShowForm(false); setStatus('Endereço criado.'); void loadLocs() }} />}
        <DataTable columns={locCols} rows={locations} rowKey={(l) => l.id} loading={locLoading} />
        <Pagination total={locTotal} offset={locOffset} limit={PAGE_SIZE} loading={locLoading} onPageChange={setLocOffset} />
      </TabPanel>

      <TabPanel active={tab === 'picklists'}>
        <SearchToolbar
          query=""
          onQueryChange={() => {}}
          placeholder="Buscar pick list..."
          count={pickLists.length}
          actions={<Select value={pickStatusFilter} options={pickStatusOptions} onChange={setPickStatusFilter} />}
        />
        <DataTable columns={pickCols} rows={pickLists} rowKey={(p) => p.id} loading={pickLoading} emptyMessage="Nenhuma pick list." />
      </TabPanel>

      <TabPanel active={tab === 'cubage'}>
        <CubageCalculator onResult={setCubageResult} onStatus={setStatus} />
        {cubageResult && (
          <div style={{ marginTop: 16 }}>
            <KpiRow>
              <KpiCard label="Peso Total" value={`${fmtQty(cubageResult.totalWeightKg, 3)} kg`} />
              <KpiCard label="Volume Total" value={`${fmtQty(cubageResult.totalVolumeM3, 6)} m³`} />
              <KpiCard label="Itens" value={cubageResult.items.length} />
            </KpiRow>
            {cubageResult.items.length > 0 && (
              <DataTable
                columns={[
                  { key: 'name', header: 'Produto', render: (it) => it.productName },
                  { key: 'qty', header: 'Qtd', align: 'right', render: (it) => fmtQty(it.quantity, 0) },
                  { key: 'weight', header: 'Peso (kg)', align: 'right', render: (it) => fmtQty(it.weightKg, 3) },
                  { key: 'volume', header: 'Volume (m³)', align: 'right', render: (it) => fmtQty(it.volumeM3, 6) },
                ]}
                rows={cubageResult.items}
                rowKey={(it) => it.productId}
              />
            )}
          </div>
        )}
      </TabPanel>
    </div>
  )
}

function LocationForm({ onSaved }: { onSaved: () => void }) {
  const [warehouseId, setWarehouseId] = useState('')
  const [aisle, setAisle] = useState('')
  const [shelf, setShelf] = useState('')
  const [level, setLevel] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!warehouseId || !aisle || !shelf || !level || !code) return
    setSubmitting(true); setError('')
    try { await createLocation({ warehouseId, aisle, shelf, level, code }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>ID do Depósito * <input value={warehouseId} onChange={e => setWarehouseId(e.target.value)} placeholder="Código" /></label>
        <label>Rua * <input value={aisle} onChange={e => setAisle(e.target.value)} placeholder="A, B, C..." /></label>
        <label>Prateleira * <input value={shelf} onChange={e => setShelf(e.target.value)} placeholder="01, 02..." /></label>
        <label>Nível * <input value={level} onChange={e => setLevel(e.target.value)} placeholder="1, 2, 3..." /></label>
        <label>Código * <input value={code} onChange={e => setCode(e.target.value)} placeholder="Ex: A-01-1" /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!warehouseId || !code || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Criar Endereço'}
        </button>
      </div>
    </div>
  )
}

function CubageCalculator({ onResult, onStatus }: { onResult: (r: CubageResult) => void; onStatus: (s: string) => void }) {
  const [items, setItems] = useState([{ productId: '', quantity: '' }])
  const [calculating, setCalculating] = useState(false)

  const addItem = () => setItems([...items, { productId: '', quantity: '' }])
  const updateItem = (i: number, field: string, value: string) => {
    const next = [...items]; (next[i] as Record<string, string>)[field] = value; setItems(next)
  }

  const handleCalc = async () => {
    const valid = items.filter(it => it.productId && it.quantity)
    if (valid.length === 0) return
    setCalculating(true)
    try {
      const result = await calculateCubage(valid.map(it => ({ productId: it.productId, quantity: Number(it.quantity) })))
      onResult(result)
    } catch (e) { onStatus(e instanceof Error ? e.message : 'Erro ao calcular.') }
    setCalculating(false)
  }

  return (
    <div>
      
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          <input placeholder="Código do produto" value={it.productId} onChange={e => updateItem(i, 'productId', e.target.value)} style={{ flex: 2 }} />
          <input type="number" placeholder="Quantidade" value={it.quantity} onChange={e => updateItem(i, 'quantity', e.target.value)} style={{ flex: 1 }} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="ghost" onClick={addItem}>+ Item</button>
        <button type="button" disabled={calculating} onClick={() => void handleCalc()}>
          {calculating ? 'Calculando...' : 'Calcular Cubagem'}
        </button>
      </div>
    </div>
  )
}
